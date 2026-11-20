'use strict';
const db = require('../db');
const log = require('../logger');

// Fire-and-forget: an audit failure must never break the user's request.
function audit(req, userId, action, entity = null, entityId = null) {
  const ip = req && (req.ip || (req.socket && req.socket.remoteAddress)) ? String(req.ip || req.socket.remoteAddress).slice(0, 45) : null;
  db.q('INSERT INTO audit_logs (user_id, action, entity, entity_id, ip_address, created_at) VALUES (?,?,?,?,?,NOW())',
    [userId || null, action, entity, entityId, ip]).catch((e) => log.error('audit_failed', { msg: e.message }));
}
module.exports = { audit };
