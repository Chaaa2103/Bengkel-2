'use strict';
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { config } = require('../config');
const db = require('../db');
const { issue, clear, requireAuth } = require('../middleware/auth');
const { wrap, HttpError, str, sniffImage } = require('../util');
const { audit } = require('../services/audit');
const telegram = require('../services/telegram');
const storage = require('../services/storage');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const strict = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, // only failed attempts count, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' } });

const DUMMY = bcrypt.hashSync('not-a-real-password', 12); // keeps login timing the same for unknown users
const strongPw = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 72 && /[A-Za-z]/.test(p) && /\d/.test(p); // BR02

async function publicUser(u) {
  return { user_id: u.user_id, student_id: u.student_id, full_name: u.full_name, email: u.email, role: u.role_name,
    phone: u.phone || '', faculty: u.faculty || '', telegram_linked: !!u.telegram_chat_id, photoSrc: await storage.url(u.photo_url) };
}
const loadUser = (id) => db.one(
  `SELECT u.user_id, u.student_id, u.full_name, u.email, u.phone, u.faculty, u.photo_url, u.telegram_chat_id, u.status, r.role_name
     FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = ?`, [id]);

router.post('/register', strict, wrap(async (req, res) => {
  const student_id = str(req.body.student_id, 'Student ID', { min: 5, max: 15 }).toUpperCase();
  const full_name = str(req.body.full_name, 'Full name', { min: 2, max: 100 });
  const email = str(req.body.email, 'Email', { max: 100 }).toLowerCase();
  if (!/^[A-Z]\d{9}$/.test(student_id)) throw new HttpError(400, 'Student ID looks like B032510025');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (config.allowedEmailDomain && !email.endsWith(`@${config.allowedEmailDomain}`)) {
    throw new HttpError(400, `Use your UTeM student email (@${config.allowedEmailDomain})`); // BR01
  }
  if (!strongPw(req.body.password)) throw new HttpError(400, 'Password needs 8 to 72 characters with letters and numbers');
  const hash = await bcrypt.hash(req.body.password, 12);
  try {
    const r = await db.q(
      "INSERT INTO users (role_id, student_id, full_name, email, password_hash) SELECT role_id, ?, ?, ?, ? FROM roles WHERE role_name = 'Student'",
      [student_id, full_name, email, hash]);
    audit(req, r.insertId, 'REGISTER', 'users', r.insertId);
    res.status(201).json({ message: 'Account created.' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Student ID or email is already registered');
    throw e;
  }
}));

// portal = 'student' or 'admin': the two login buttons of the website. An account can only use its own portal.
router.post('/login', strict, wrap(async (req, res) => {
  const portal = req.body.portal === 'admin' ? 'admin' : 'student';
  const id = str(req.body.identifier, 'Student ID or email', { max: 100 });
  const pw = typeof req.body.password === 'string' ? req.body.password : '';
  const u = await db.one(
    `SELECT u.user_id, u.password_hash, u.status, r.role_name FROM users u JOIN roles r ON r.role_id = u.role_id
      WHERE u.email = ? OR u.student_id = ?`, [id.toLowerCase(), id.toUpperCase()]);
  const ok = await bcrypt.compare(pw, u ? u.password_hash : DUMMY);
  if (!u || !ok || u.status !== 'Active') {
    audit(req, u ? u.user_id : null, 'LOGIN_FAILED', 'users', u ? u.user_id : null);
    throw new HttpError(401, 'Incorrect ID or password');
  }
  if (portal === 'admin' && u.role_name !== 'Admin') throw new HttpError(403, 'This is a student account. Use the Student log in.');
  if (portal === 'student' && u.role_name === 'Admin') throw new HttpError(403, 'This is an admin account. Use the Admin log in.');
  issue(res, u);
  audit(req, u.user_id, 'LOGIN', 'users', u.user_id);
  res.json({ user: await publicUser(await loadUser(u.user_id)) });
}));

router.post('/logout', wrap(async (req, res) => { clear(res); res.json({ message: 'Logged out' }); }));
router.get('/me', requireAuth, wrap(async (req, res) => res.json({ user: await publicUser(req.user) })));
router.get('/profile', requireAuth, wrap(async (req, res) => res.json({ user: await publicUser(req.user) })));

// Update own profile: name, phone, faculty, password, manual Telegram chat id.
router.patch('/profile', requireAuth, wrap(async (req, res) => {
  const b = req.body; const out = {}; const sets = []; const args = [];
  if (b.full_name !== undefined) { sets.push('full_name = ?'); args.push(str(b.full_name, 'Full name', { min: 2, max: 100 })); }
  if (b.phone !== undefined) {
    const phone = String(b.phone).trim();
    if (phone && !/^[0-9+\- ]{7,20}$/.test(phone)) throw new HttpError(400, 'Phone number can only contain digits, spaces, + and -');
    sets.push('phone = ?'); args.push(phone || null);
  }
  if (b.faculty !== undefined) { sets.push('faculty = ?'); args.push(str(b.faculty, 'Faculty or programme', { max: 100, optional: true })); }
  if (b.telegram_chat_id !== undefined) {
    const chat = String(b.telegram_chat_id).trim();
    if (chat && !/^-?\d{5,20}$/.test(chat)) throw new HttpError(400, 'A Telegram chat ID is a number such as 123456789');
    sets.push('telegram_chat_id = ?'); args.push(chat || null);
    out.telegram_test = chat ? await telegram.sendMessage(chat, 'UTeM Smart Sports: Telegram is linked to your account.') : 'Unlinked';
    audit(req, req.user.user_id, 'TELEGRAM_LINKED', 'users', req.user.user_id);
  }
  if (b.new_password !== undefined && b.new_password !== '') {
    const row = await db.one('SELECT password_hash FROM users WHERE user_id = ?', [req.user.user_id]);
    if (!(await bcrypt.compare(String(b.current_password || ''), row.password_hash))) throw new HttpError(400, 'Current password is incorrect');
    if (b.new_password !== b.confirm_password) throw new HttpError(400, 'The two new passwords do not match');
    if (b.new_password === b.current_password) throw new HttpError(400, 'The new password must be different from the current one');
    if (!strongPw(b.new_password)) throw new HttpError(400, 'Password needs 8 to 72 characters with letters and numbers');
    sets.push('password_hash = ?'); args.push(await bcrypt.hash(b.new_password, 12));
    audit(req, req.user.user_id, 'PASSWORD_CHANGED', 'users', req.user.user_id);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  await db.q(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`, [...args, req.user.user_id]);
  res.json({ message: 'Profile saved', ...out, user: await publicUser(await loadUser(req.user.user_id)) });
}));

// Profile photo (JPEG, PNG or WebP up to 2 MB)
router.post('/photo', requireAuth, upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose an image file');
  const t = sniffImage(req.file.buffer);
  if (!t) throw new HttpError(400, 'Only JPEG, PNG or WebP images are accepted');
  const old = await db.one('SELECT photo_url FROM users WHERE user_id = ?', [req.user.user_id]);
  const key = await storage.put(`profiles/${req.user.user_id}-${Date.now()}.${t.ext}`, req.file.buffer, t.type);
  await db.q('UPDATE users SET photo_url = ? WHERE user_id = ?', [key, req.user.user_id]);
  if (old) storage.remove(old.photo_url).catch(() => {});
  audit(req, req.user.user_id, 'PROFILE_PHOTO', 'users', req.user.user_id);
  res.json({ photoSrc: await storage.url(key) });
}));

/* ---------- Telegram linking ---------- */
router.get('/telegram/status', requireAuth, wrap(async (req, res) => {
  const bot = await telegram.botInfo();
  const u = await db.one('SELECT telegram_chat_id FROM users WHERE user_id = ?', [req.user.user_id]);
  res.json({ linked: !!(u && u.telegram_chat_id), bot });
}));

router.post('/telegram/link-code', requireAuth, wrap(async (req, res) => {
  const bot = await telegram.botInfo();
  if (!bot.configured) throw new HttpError(503, 'Telegram is not set up yet. Ask the administrator to add the bot token.');
  if (!bot.ok) throw new HttpError(503, `The Telegram bot is not working (${bot.error}). Tell the administrator.`);
  await db.q('DELETE FROM telegram_link_codes WHERE user_id = ? OR expires_at < NOW()', [req.user.user_id]);
  const code = crypto.randomBytes(5).toString('hex');
  await db.q('INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 10 MINUTE)', [code, req.user.user_id]);
  res.json({ code, username: bot.username, url: `https://t.me/${bot.username}?start=${code}`, expires_minutes: 10 });
}));

router.post('/telegram/test', requireAuth, wrap(async (req, res) => {
  const u = await db.one('SELECT telegram_chat_id FROM users WHERE user_id = ?', [req.user.user_id]);
  if (!u || !u.telegram_chat_id) throw new HttpError(409, 'Telegram is not linked yet');
  const status = await telegram.sendMessage(u.telegram_chat_id, 'UTeM Smart Sports: this is a test message. Your alerts are working.');
  res.json({ status });
}));

router.delete('/telegram', requireAuth, wrap(async (req, res) => {
  await db.q('UPDATE users SET telegram_chat_id = NULL WHERE user_id = ?', [req.user.user_id]);
  audit(req, req.user.user_id, 'TELEGRAM_UNLINKED', 'users', req.user.user_id);
  res.json({ message: 'Telegram unlinked' });
}));

module.exports = router;
