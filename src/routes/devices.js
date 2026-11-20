'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { wrap, HttpError, toInt, str, oneOf } = require('../util');
const { audit } = require('../services/audit');
const iot = require('../services/iot');

const router = express.Router();
router.use(requireAuth, requireRole('Admin'));

const LIST = `SELECT d.device_id, d.facility_id, d.thing_name, d.firmware_version, d.status, d.last_seen, d.light_state,
                     f.facility_name, TIMESTAMPDIFF(SECOND, d.last_seen, NOW()) AS seconds_since_seen
                FROM iot_devices d JOIN facilities f ON f.facility_id = d.facility_id`;

router.get('/', wrap(async (_req, res) => res.json({ mode: iot.mode(), devices: await db.q(`${LIST} ORDER BY d.thing_name`) })));

// Live feed for the hardware monitor: latest commands and status changes.
router.get('/feed', wrap(async (_req, res) => {
  res.json(await db.q(
    `(SELECT 'command' AS kind, l.sent_at AS at, d.thing_name, CONCAT(l.command_type, ' - ', l.ack_status, IF(l.retry_count > 0, CONCAT(' (retry ', l.retry_count, ')'), '')) AS detail
        FROM light_command_logs l JOIN iot_devices d ON d.device_id = l.device_id ORDER BY l.sent_at DESC LIMIT 30)
     UNION ALL
     (SELECT 'status', s.recorded_at, d.thing_name, s.status FROM device_status_logs s JOIN iot_devices d ON d.device_id = s.device_id ORDER BY s.recorded_at DESC LIMIT 30)
     ORDER BY at DESC LIMIT 40`));
}));

const body = (b) => ({ facility_id: toInt(b.facility_id, 'facility_id'), thing_name: str(b.thing_name, 'Thing name', { min: 3, max: 100 }) });
const dup = (e) => { if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'That facility or Thing name already has a device'); if (e.code === 'ER_NO_REFERENCED_ROW_2') throw new HttpError(400, 'Unknown facility'); throw e; };

router.post('/', wrap(async (req, res) => {
  const d = body(req.body);
  try {
    const r = await db.q('INSERT INTO iot_devices (facility_id, thing_name) VALUES (?,?)', [d.facility_id, d.thing_name]);
    audit(req, req.user.user_id, 'DEVICE_CREATED', 'iot_devices', r.insertId);
    res.status(201).json({ device_id: r.insertId });
  } catch (e) { dup(e); }
}));
router.put('/:id', wrap(async (req, res) => {
  const d = body(req.body); const id = toInt(req.params.id, 'id');
  try {
    const r = await db.q('UPDATE iot_devices SET facility_id = ?, thing_name = ? WHERE device_id = ?', [d.facility_id, d.thing_name, id]);
    if (!r.affectedRows) throw new HttpError(404, 'Device not found');
    audit(req, req.user.user_id, 'DEVICE_UPDATED', 'iot_devices', id);
    res.json({ message: 'Device updated' });
  } catch (e) { dup(e); }
}));
router.delete('/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  const r = await db.q('DELETE FROM iot_devices WHERE device_id = ?', [id]);
  if (!r.affectedRows) throw new HttpError(404, 'Device not found');
  audit(req, req.user.user_id, 'DEVICE_DELETED', 'iot_devices', id);
  res.json({ message: 'Device deleted' });
}));

// Manual override ("Manual Override Relay" in the Progress I monitor screen). Recorded in the audit log.
router.post('/:id/command', wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  const command = oneOf(req.body.command, ['ON', 'OFF'], 'command');
  const device = await db.one('SELECT device_id, thing_name FROM iot_devices WHERE device_id = ?', [id]);
  if (!device) throw new HttpError(404, 'Device not found');
  const cmdId = await iot.sendCommand({ device, command, bookingId: null });
  audit(req, req.user.user_id, `MANUAL_${command}`, 'iot_devices', id);
  res.status(202).json({ command_id: cmdId, message: `${command} sent to ${device.thing_name}` });
}));

module.exports = router;
