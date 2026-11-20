'use strict';
const express = require('express');
const { config } = require('../config');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { wrap, HttpError, toInt, isDate, oneOf, hhmm } = require('../util');
const { audit } = require('../services/audit');
const { validateSlot } = require('../services/bookingRules');
const notify = require('../services/notify');
const receipt = require('../services/receipt');
const storage = require('../services/storage');
const log = require('../logger');

const router = express.Router();
router.use(requireAuth);

const SELECT = `SELECT b.booking_id, b.booking_date, b.status, b.created_at, b.cancelled_at, b.receipt_url, b.user_id,
       b.facility_id, b.slot_id, f.facility_name, f.location, ft.type_name, ts.start_time, ts.end_time,
       u.full_name, u.student_id,
       (TIMESTAMPDIFF(MINUTE, NOW(), TIMESTAMP(b.booking_date, ts.start_time)) >= ?) AS can_change
  FROM bookings b JOIN facilities f ON f.facility_id = b.facility_id JOIN facility_types ft ON ft.type_id = f.type_id
  JOIN time_slots ts ON ts.slot_id = b.slot_id JOIN users u ON u.user_id = b.user_id`;
const shape = (r) => ({ ...r, start_time: hhmm(r.start_time), end_time: hhmm(r.end_time), can_change: !!r.can_change && r.status === 'Confirmed' });

async function loadOwn(req, id) {
  const b = await db.one(`${SELECT} WHERE b.booking_id = ?`, [config.rules.cancelCutoffHours * 60, id]);
  if (!b) throw new HttpError(404, 'Booking not found');
  if (b.user_id !== req.user.user_id && req.user.role_name !== 'Admin') throw new HttpError(403, 'You can only manage your own bookings'); // BR05
  return b;
}

// CREATE (BR07 to BR11 + BR08 double-booking guard through the unique key)
router.post('/', wrap(async (req, res) => {
  const facilityId = toInt(req.body.facility_id, 'facility_id');
  const slotId = toInt(req.body.slot_id, 'slot_id');
  if (!isDate(req.body.booking_date)) throw new HttpError(400, 'booking_date must look like 2026-11-05');
  if (config.requireTelegram && !req.user.telegram_chat_id) throw new HttpError(409, 'Link your Telegram first (Profile > Telegram) so you get your court-ready alert.');
  try {
    const id = await db.tx(async (c) => {
      await validateSlot(c, { userId: req.user.user_id, facilityId, slotId, date: req.body.booking_date });
      const [r] = await c.query('INSERT INTO bookings (user_id, facility_id, slot_id, booking_date) VALUES (?,?,?,?)',
        [req.user.user_id, facilityId, slotId, req.body.booking_date]);
      return r.insertId;
    });
    audit(req, req.user.user_id, 'BOOKING_CREATED', 'bookings', id);
    // Receipt (S3) and Telegram run after the response so the student never waits for them.
    receipt.ensureReceipt(id).catch((e) => log.error('receipt_failed', { msg: e.message }));
    notify.bookingConfirmed(id).catch((e) => log.error('notify_failed', { msg: e.message }));
    res.status(201).json({ booking_id: id, message: 'Booking confirmed' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Sorry, someone just booked this slot. Pick another one.');
    throw e;
  }
}));

// READ + SEARCH. Students get their own bookings. Admins can pass ?all=1 to see everyone's.
router.get('/', wrap(async (req, res) => {
  const admin = req.user.role_name === 'Admin' && req.query.all === '1';
  const where = []; const args = [config.rules.cancelCutoffHours * 60];
  if (!admin) { where.push('b.user_id = ?'); args.push(req.user.user_id); }
  if (req.query.status) { where.push('b.status = ?'); args.push(oneOf(req.query.status, ['Confirmed', 'Cancelled', 'Completed'], 'status')); }
  if (req.query.facility_id) { where.push('b.facility_id = ?'); args.push(toInt(req.query.facility_id, 'facility_id')); }
  if (req.query.from) { if (!isDate(req.query.from)) throw new HttpError(400, 'from is not a valid date'); where.push('b.booking_date >= ?'); args.push(req.query.from); }
  if (req.query.to) { if (!isDate(req.query.to)) throw new HttpError(400, 'to is not a valid date'); where.push('b.booking_date <= ?'); args.push(req.query.to); }
  if (req.query.q) {
    const like = `%${String(req.query.q).slice(0, 60)}%`;
    where.push('(f.facility_name LIKE ? OR u.full_name LIKE ? OR u.student_id LIKE ?)'); args.push(like, like, like);
  }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await db.q(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.booking_date DESC, ts.start_time DESC LIMIT ?`, [...args, limit]);
  res.json(rows.map(shape));
}));

router.get('/:id', wrap(async (req, res) => res.json(shape(await loadOwn(req, toInt(req.params.id, 'id'))))));

// UPDATE (reschedule): moves a Confirmed booking to another slot or date, with the same rules as creating one.
router.put('/:id', wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  const b = await loadOwn(req, id);
  if (b.status !== 'Confirmed') throw new HttpError(409, 'Only Confirmed bookings can be changed');
  if (!b.can_change && req.user.role_name !== 'Admin') throw new HttpError(409, `Changes close ${config.rules.cancelCutoffHours} hours before the slot starts`);
  const slotId = toInt(req.body.slot_id, 'slot_id');
  if (!isDate(req.body.booking_date)) throw new HttpError(400, 'booking_date must look like 2026-11-05');
  try {
    await db.tx(async (c) => {
      await validateSlot(c, { userId: b.user_id, facilityId: b.facility_id, slotId, date: req.body.booking_date, excludeBookingId: id });
      await c.query('UPDATE bookings SET slot_id = ?, booking_date = ?, receipt_url = NULL WHERE booking_id = ?', [slotId, req.body.booking_date, id]);
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'That slot is already booked');
    throw e;
  }
  audit(req, req.user.user_id, 'BOOKING_RESCHEDULED', 'bookings', id);
  receipt.ensureReceipt(id).catch(() => {});
  notify.bookingConfirmed(id, 'rescheduled').catch(() => {});
  res.json({ message: 'Booking rescheduled' });
}));

// Cancel (BR12): owner needs at least 2 hours before start. Admin can always cancel.
router.patch('/:id/cancel', wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  const b = await loadOwn(req, id);
  if (b.status !== 'Confirmed') throw new HttpError(409, 'Only Confirmed bookings can be cancelled');
  if (!b.can_change && req.user.role_name !== 'Admin') throw new HttpError(409, `Cancellation closes ${config.rules.cancelCutoffHours} hours before the slot starts`);
  await db.q("UPDATE bookings SET status = 'Cancelled', cancelled_at = NOW(), receipt_url = NULL WHERE booking_id = ? AND status = 'Confirmed'", [id]);
  audit(req, req.user.user_id, 'BOOKING_CANCELLED', 'bookings', id);
  notify.bookingCancelled(id).catch(() => {});
  res.json({ message: 'Booking cancelled. The slot is free again.' });
}));

// DELETE (admin housekeeping): only Cancelled or Completed records can be removed.
router.delete('/:id', requireRole('Admin'), wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  const b = await db.one('SELECT status, receipt_url FROM bookings WHERE booking_id = ?', [id]);
  if (!b) throw new HttpError(404, 'Booking not found');
  if (b.status === 'Confirmed') throw new HttpError(409, 'Cancel the booking before deleting it');
  await db.q('DELETE FROM bookings WHERE booking_id = ?', [id]);
  storage.remove(b.receipt_url).catch(() => {});
  audit(req, req.user.user_id, 'BOOKING_DELETED', 'bookings', id);
  res.json({ message: 'Booking record deleted' });
}));

router.get('/:id/receipt', wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  await loadOwn(req, id);
  const key = await receipt.ensureReceipt(id);
  res.json({ url: await storage.url(key) });
}));

module.exports = router;
