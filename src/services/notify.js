'use strict';
const db = require('../db');
const { sendMessage } = require('./telegram');
const { hhmm } = require('../util');

async function send(userId, bookingId, type, message) {
  const u = await db.one('SELECT telegram_chat_id FROM users WHERE user_id = ?', [userId]);
  const status = u && u.telegram_chat_id ? await sendMessage(u.telegram_chat_id, message) : 'Skipped';
  await db.q('INSERT INTO notifications (user_id, booking_id, type, message, status, sent_at) VALUES (?,?,?,?,?,NOW())',
    [userId, bookingId, type, message.slice(0, 255), status]);
  return status;
}

async function bookingInfo(bookingId) {
  return db.one(
    `SELECT b.booking_id, b.user_id, b.booking_date, f.facility_name, f.location, ts.start_time, ts.end_time
       FROM bookings b JOIN facilities f ON f.facility_id = b.facility_id JOIN time_slots ts ON ts.slot_id = b.slot_id
      WHERE b.booking_id = ?`, [bookingId]);
}
const when = (b) => `${b.booking_date} ${hhmm(b.start_time)}-${hhmm(b.end_time)}`;

async function bookingConfirmed(id, verb = 'confirmed') {
  const b = await bookingInfo(id); if (!b) return;
  return send(b.user_id, id, 'Confirmation', `Booking ${verb}: ${b.facility_name} (${b.location}) on ${when(b)}. Ref #${id}`);
}
async function bookingCancelled(id) {
  const b = await bookingInfo(id); if (!b) return;
  return send(b.user_id, id, 'Cancellation', `Booking cancelled: ${b.facility_name} on ${when(b)}. Ref #${id}`);
}
async function courtReady(id) {
  const b = await bookingInfo(id); if (!b) return;
  const dup = await db.one("SELECT 1 AS x FROM notifications WHERE booking_id = ? AND type = 'CourtReady'", [id]);
  if (dup) return 'Skipped';
  return send(b.user_id, id, 'CourtReady', `Your court is ready: ${b.facility_name}, ${when(b)}. The lights are on.`);
}
async function alertAdmins(text) {
  const admins = await db.q("SELECT u.telegram_chat_id FROM users u JOIN roles r ON r.role_id = u.role_id WHERE r.role_name = 'Admin' AND u.telegram_chat_id IS NOT NULL AND u.status = 'Active'");
  for (const a of admins) await sendMessage(a.telegram_chat_id, `ALERT: ${text}`);
}

module.exports = { bookingConfirmed, bookingCancelled, courtReady, alertAdmins };
