'use strict';
// Turns confirmed bookings into light commands. Runs on every web server, but a MySQL named lock makes sure only ONE server
// does the work each cycle, so auto scaling never produces duplicate commands.
const { config } = require('../config');
const db = require('../db');
const log = require('../logger');
const iot = require('./iot');
const telegram = require('./telegram');
const notify = require('./notify');
const { audit } = require('./audit');

const LOCK = 'smartsports_scheduler';
const START = 'TIMESTAMP(b.booking_date, ts.start_time)';
const END = 'TIMESTAMP(b.booking_date, ts.end_time)';
let timer = null;
const status = { lastTick: null, lastMs: null, lastError: null, ran: 0 };

async function tick() {
  const conn = await db.getPool().getConnection();
  try {
    const [[l]] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK]);
    if (!l.got) return;
    const t0 = Date.now();
    try {
      await telegram.pollUpdates().catch((e) => log.warn('telegram_poll_failed', { msg: e.message }));
      await work();
      Object.assign(status, { lastTick: new Date().toISOString(), lastMs: Date.now() - t0, lastError: null, ran: status.ran + 1 });
    } catch (e) { status.lastError = e.message; throw e; } finally { await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]); }
  } finally { conn.release(); }
}

async function work() {
  const { leadMin, offlineAfterMin, ackTimeoutSec, maxRetries } = config.iot;

  // 1. Commands with no ACK in time are marked Failed (BR19). The third failure alerts the admin.
  const stale = await db.q(
    `SELECT l.command_id, l.booking_id, l.command_type, d.thing_name FROM light_command_logs l JOIN iot_devices d ON d.device_id = l.device_id
      WHERE l.ack_status = 'Pending' AND l.sent_at < NOW() - INTERVAL ? SECOND`, [ackTimeoutSec]);
  for (const s of stale) {
    await db.q("UPDATE light_command_logs SET ack_status = 'Failed' WHERE command_id = ? AND ack_status = 'Pending'", [s.command_id]);
    if (s.booking_id) {
      const n = await db.one("SELECT COUNT(*) AS c FROM light_command_logs WHERE booking_id = ? AND command_type = ? AND ack_status = 'Failed'", [s.booking_id, s.command_type]);
      if (n.c >= maxRetries) {
        audit(null, null, 'LIGHT_FAILED', 'bookings', s.booking_id);
        await notify.alertAdmins(`Light ${s.command_type} failed after ${maxRetries} attempts for booking #${s.booking_id} (${s.thing_name}).`);
      }
    }
  }

  // 2. ON: confirmed bookings inside [start - lead, end) that have no live ON command and fewer than 3 failures.
  const dueOn = await db.q(
    `SELECT b.booking_id, d.device_id, d.thing_name
       FROM bookings b JOIN time_slots ts ON ts.slot_id = b.slot_id JOIN iot_devices d ON d.facility_id = b.facility_id
      WHERE b.status = 'Confirmed' AND NOW() >= ${START} - INTERVAL ? MINUTE AND NOW() < ${END}
        AND NOT EXISTS (SELECT 1 FROM light_command_logs l WHERE l.booking_id = b.booking_id AND l.command_type = 'ON' AND l.ack_status IN ('Pending','Acknowledged'))
        AND (SELECT COUNT(*) FROM light_command_logs l WHERE l.booking_id = b.booking_id AND l.command_type = 'ON' AND l.ack_status = 'Failed') < ?`,
    [leadMin, maxRetries]);
  for (const b of dueOn) await iot.sendCommand({ device: b, command: 'ON', bookingId: b.booking_id });

  // 3. OFF: lights that were switched on for a booking that has ended (or was cancelled), unless another booking is
  //    already active on the same facility (back-to-back, BR17).
  const dueOff = await db.q(
    `SELECT b.booking_id, d.device_id, d.thing_name
       FROM bookings b JOIN time_slots ts ON ts.slot_id = b.slot_id JOIN iot_devices d ON d.facility_id = b.facility_id
      WHERE b.booking_date >= CURDATE() - INTERVAL 1 DAY AND (NOW() >= ${END} OR b.status = 'Cancelled')
        AND EXISTS (SELECT 1 FROM light_command_logs l WHERE l.booking_id = b.booking_id AND l.command_type = 'ON' AND l.ack_status = 'Acknowledged')
        AND NOT EXISTS (SELECT 1 FROM light_command_logs l WHERE l.booking_id = b.booking_id AND l.command_type = 'OFF' AND l.ack_status IN ('Pending','Acknowledged'))
        AND (SELECT COUNT(*) FROM light_command_logs l WHERE l.booking_id = b.booking_id AND l.command_type = 'OFF' AND l.ack_status = 'Failed') < ?
        AND NOT EXISTS (
          SELECT 1 FROM bookings b2 JOIN time_slots t2 ON t2.slot_id = b2.slot_id
           WHERE b2.facility_id = b.facility_id AND b2.booking_id <> b.booking_id AND b2.status = 'Confirmed'
             AND NOW() >= TIMESTAMP(b2.booking_date, t2.start_time) - INTERVAL ? MINUTE AND NOW() < TIMESTAMP(b2.booking_date, t2.end_time))`,
    [maxRetries, leadMin]);
  for (const b of dueOff) await iot.sendCommand({ device: b, command: 'OFF', bookingId: b.booking_id });

  // 4. Finished bookings become Completed after a 10 minute grace period.
  await db.q(
    `UPDATE bookings b JOIN time_slots ts ON ts.slot_id = b.slot_id SET b.status = 'Completed'
      WHERE b.status = 'Confirmed' AND NOW() >= ${END} + INTERVAL 10 MINUTE`);

  // 5. Devices that stopped sending heartbeats become Offline and the change is logged (BR20).
  const gone = await db.q(
    "SELECT device_id, thing_name FROM iot_devices WHERE status = 'Online' AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL ? MINUTE)", [offlineAfterMin]);
  for (const d of gone) {
    await db.q("UPDATE iot_devices SET status = 'Offline' WHERE device_id = ?", [d.device_id]);
    await db.q("INSERT INTO device_status_logs (device_id, status, recorded_at) VALUES (?, 'Offline', NOW())", [d.device_id]);
    log.warn('device_offline', { thing: d.thing_name });
  }
}

function start() {
  timer = setInterval(() => tick().catch((e) => log.error('scheduler_failed', { msg: e.message })), config.iot.schedulerSec * 1000);
  tick().catch((e) => log.error('scheduler_failed', { msg: e.message }));
}
const stop = () => timer && clearInterval(timer);

module.exports = { start, stop, tick, status };
