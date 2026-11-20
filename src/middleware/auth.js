'use strict';
const jwt = require('jsonwebtoken');
const { config } = require('../config');
const db = require('../db');
const { HttpError } = require('../util');

const COOKIE = 'ss_token';
const TTL_SEC = 2 * 60 * 60;

function issue(res, user) {
  const token = jwt.sign({ sub: user.user_id }, config.sessionSecret, { expiresIn: TTL_SEC, issuer: 'smartsports' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: TTL_SEC * 1000, path: '/' });
}
const clear = (res) => res.clearCookie(COOKIE, { path: '/' });

async function load(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  let p;
  try { p = jwt.verify(token, config.sessionSecret, { issuer: 'smartsports' }); } catch (_) { return null; }
  const u = await db.one(
    `SELECT u.user_id, u.student_id, u.full_name, u.email, u.phone, u.faculty, u.photo_url, u.status, u.telegram_chat_id, r.role_name
       FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = ?`, [p.sub]);
  return u && u.status === 'Active' ? u : null; // deactivated accounts lose access immediately
}

const optionalAuth = async (req, _res, next) => {
  try { req.user = await load(req); next(); } catch (e) { next(e); }
};
const requireAuth = async (req, _res, next) => {
  try {
    req.user = await load(req);
    if (!req.user) throw new HttpError(401, 'Please log in to continue');
    next();
  } catch (e) { next(e); }
};
const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role_name)) return next(new HttpError(403, 'You do not have permission to do this'));
  next();
};
// Simple CSRF defence: state-changing API calls must carry a custom header that cross-site forms cannot send.
const csrfGuard = (req, _res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('X-Requested-With') !== 'SmartSports') {
    return next(new HttpError(403, 'Missing request header'));
  }
  next();
};

module.exports = { issue, clear, optionalAuth, requireAuth, requireRole, csrfGuard };
