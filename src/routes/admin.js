'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { wrap, HttpError, toInt, oneOf } = require('../util');
const { audit } = require('../services/audit');

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const os = require('os');
const { config } = require('../config');
const metrics = require('../services/metrics');
const instance = require('../services/instance');
const storage = require('../services/storage');
const telegram = require('../services/telegram');
const iot = require('../services/iot');
const scheduler = require('../services/scheduler');

const router = express.Router();
router.use(requireAuth, requireRole('Admin'));

router.get('/audit', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const where = []; const args = [];
  if (req.query.action) { where.push('a.action = ?'); args.push(String(req.query.action).slice(0, 50)); }
  if (req.query.q) { where.push('(a.action LIKE ? OR u.full_name LIKE ? OR a.ip_address LIKE ?)'); const l = `%${String(req.query.q).slice(0, 50)}%`; args.push(l, l, l); }
  res.json(await db.q(
    `SELECT a.audit_id, a.created_at, a.action, a.entity, a.entity_id, a.ip_address, u.full_name
       FROM audit_logs a LEFT JOIN users u ON u.user_id = a.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.audit_id DESC LIMIT ?`, [...args, limit]));
}));

router.get('/users', wrap(async (req, res) => {
  const args = []; let w = '';
  if (req.query.q) { w = 'WHERE u.full_name LIKE ? OR u.student_id LIKE ? OR u.email LIKE ?'; const l = `%${String(req.query.q).slice(0, 50)}%`; args.push(l, l, l); }
  res.json(await db.q(
    `SELECT u.user_id, u.student_id, u.full_name, u.email, u.status, u.created_at, r.role_name, (u.telegram_chat_id IS NOT NULL) AS telegram_linked
       FROM users u JOIN roles r ON r.role_id = u.role_id ${w} ORDER BY u.created_at DESC LIMIT 200`, args));
}));

router.patch('/users/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  if (id === req.user.user_id) throw new HttpError(400, 'You cannot change your own role or status');
  const sets = []; const args = [];
  if (req.body.status !== undefined) { sets.push('status = ?'); args.push(oneOf(req.body.status, ['Active', 'Inactive'], 'status')); }
  if (req.body.role !== undefined) { sets.push('role_id = (SELECT role_id FROM roles WHERE role_name = ?)'); args.push(oneOf(req.body.role, ['Student', 'Admin'], 'role')); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  const r = await db.q(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`, [...args, id]);
  if (!r.affectedRows) throw new HttpError(404, 'User not found');
  audit(req, req.user.user_id, 'USER_UPDATED', 'users', id);
  res.json({ message: 'User updated' });
}));

// Admin sets a temporary password for a student who forgot theirs. It is shown once and only the hash is stored.
router.post('/users/:id/reset-password', wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  const temp = `${crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8)}a1`;
  const r = await db.q('UPDATE users SET password_hash = ? WHERE user_id = ?', [await bcrypt.hash(temp, 12), id]);
  if (!r.affectedRows) throw new HttpError(404, 'User not found');
  audit(req, req.user.user_id, 'PASSWORD_RESET_BY_ADMIN', 'users', id);
  res.json({ temporary_password: temp });
}));

// Monitoring page: health of the server that answered, the database, storage, IoT, Telegram and recent traffic.
router.get('/monitor', wrap(async (_req, res) => {
  const t0 = Date.now(); let dbOk = true;
  try { await db.ping(); } catch (_) { dbOk = false; }
  const dbMs = Date.now() - t0;
  const [counts, store, bot] = await Promise.all([
    dbOk ? db.one(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM bookings WHERE booking_date = CURDATE() AND status <> 'Cancelled') AS bookings_today,
        (SELECT COUNT(*) FROM iot_devices WHERE status = 'Online') AS devices_online, (SELECT COUNT(*) FROM iot_devices) AS devices_total,
        (SELECT COUNT(*) FROM audit_logs WHERE action = 'LOGIN_FAILED' AND created_at > NOW() - INTERVAL 1 HOUR) AS failed_logins_1h,
        (SELECT COUNT(*) FROM light_command_logs WHERE ack_status = 'Failed' AND sent_at > NOW() - INTERVAL 24 HOUR) AS failed_commands_24h`) : null,
    storage.check(), telegram.botInfo()]);
  const mem = process.memoryUsage();
  res.json({
    server: { ...instance.get(), node: process.version, pid: process.pid, memory_mb: Math.round(mem.rss / 1048576), load_1m: Math.round(os.loadavg()[0] * 100) / 100, env: config.env },
    database: { ok: dbOk, latency_ms: dbMs }, storage: store, telegram: bot,
    iot: { mode: iot.mode(), ...(counts ? { online: counts.devices_online, total: counts.devices_total } : {}) },
    scheduler: scheduler.status, counts, traffic: metrics.snapshot(30),
  });
}));

module.exports = router;
