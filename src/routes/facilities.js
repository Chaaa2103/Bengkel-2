'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { optionalAuth, requireAuth, requireRole } = require('../middleware/auth');
const { wrap, HttpError, toInt, str, oneOf, isDate, hhmm } = require('../util');
const { audit } = require('../services/audit');
const storage = require('../services/storage');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

const withPhoto = async (f) => ({ ...f, photoSrc: await storage.url(f.photo_url) });

router.get('/types', wrap(async (_req, res) => res.json(await db.q('SELECT type_id, type_name FROM facility_types ORDER BY type_name'))));

// READ + SEARCH: ?q= matches name or location, ?type_id= and ?status= filter. Students only see Active facilities.
router.get('/', optionalAuth, wrap(async (req, res) => {
  const isAdmin = req.user && req.user.role_name === 'Admin';
  const where = []; const args = [];
  if (!isAdmin) where.push("f.status = 'Active'");
  else if (req.query.status) { where.push('f.status = ?'); args.push(oneOf(req.query.status, ['Active', 'Inactive'], 'status')); }
  if (req.query.q) { where.push('(f.facility_name LIKE ? OR f.location LIKE ?)'); const like = `%${String(req.query.q).slice(0, 60)}%`; args.push(like, like); }
  if (req.query.type_id) { where.push('f.type_id = ?'); args.push(toInt(req.query.type_id, 'type_id')); }
  const rows = await db.q(
    `SELECT f.facility_id, f.facility_name, f.location, f.capacity, f.photo_url, f.status, ft.type_id, ft.type_name,
            d.thing_name, d.status AS device_status, d.light_state
       FROM facilities f JOIN facility_types ft ON ft.type_id = f.type_id LEFT JOIN iot_devices d ON d.facility_id = f.facility_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ft.type_name, f.facility_name`, args);
  res.json(await Promise.all(rows.map(withPhoto)));
}));

router.get('/:id', wrap(async (req, res) => {
  const f = await db.one(
    `SELECT f.*, ft.type_name FROM facilities f JOIN facility_types ft ON ft.type_id = f.type_id WHERE f.facility_id = ?`, [toInt(req.params.id, 'id')]);
  if (!f) throw new HttpError(404, 'Facility not found');
  res.json(await withPhoto(f));
}));

// COMPLEX QUERY: every time slot for one facility and date with its state (LEFT JOIN of slots onto confirmed bookings).
router.get('/:id/availability', optionalAuth, wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  const date = req.query.date;
  if (!isDate(date)) throw new HttpError(400, 'date must look like 2026-11-05');
  const rows = await db.q(
    `SELECT ts.slot_id, ts.start_time, ts.end_time, b.booking_id, b.user_id AS booked_by,
            (TIMESTAMP(?, ts.start_time) <= NOW()) AS is_past
       FROM time_slots ts
       LEFT JOIN bookings b ON b.slot_id = ts.slot_id AND b.facility_id = ? AND b.booking_date = ? AND b.status = 'Confirmed'
      ORDER BY ts.start_time`, [date, id, date]);
  const me = req.user ? req.user.user_id : null;
  res.json(rows.map((r) => ({
    slot_id: r.slot_id, start: hhmm(r.start_time), end: hhmm(r.end_time),
    state: r.is_past ? 'past' : r.booked_by === null ? 'available' : r.booked_by === me ? 'mine' : 'booked',
    booking_id: r.booked_by === me ? r.booking_id : null,
  })));
}));

function parseBody(b) {
  return {
    facility_name: str(b.facility_name, 'Facility name', { min: 3, max: 100 }),
    type_id: toInt(b.type_id, 'Facility type'),
    location: str(b.location, 'Location', { min: 3, max: 150 }),
    capacity: b.capacity === '' || b.capacity === undefined || b.capacity === null ? null : toInt(b.capacity, 'Capacity'),
    status: oneOf(b.status || 'Active', ['Active', 'Inactive'], 'status'),
  };
}
const dupMsg = (e) => { if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'A facility with this name already exists'); if (e.code === 'ER_NO_REFERENCED_ROW_2') throw new HttpError(400, 'Unknown facility type'); throw e; };

// CREATE
router.post('/', requireAuth, requireRole('Admin'), wrap(async (req, res) => {
  const f = parseBody(req.body);
  try {
    const r = await db.q('INSERT INTO facilities (type_id, facility_name, location, capacity, status) VALUES (?,?,?,?,?)',
      [f.type_id, f.facility_name, f.location, f.capacity, f.status]);
    audit(req, req.user.user_id, 'FACILITY_CREATED', 'facilities', r.insertId);
    res.status(201).json({ facility_id: r.insertId });
  } catch (e) { dupMsg(e); }
}));

// UPDATE
router.put('/:id', requireAuth, requireRole('Admin'), wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id'); const f = parseBody(req.body);
  try {
    const r = await db.q('UPDATE facilities SET type_id=?, facility_name=?, location=?, capacity=?, status=? WHERE facility_id=?',
      [f.type_id, f.facility_name, f.location, f.capacity, f.status, id]);
    if (!r.affectedRows) throw new HttpError(404, 'Facility not found');
    audit(req, req.user.user_id, 'FACILITY_UPDATED', 'facilities', id);
    res.json({ message: 'Facility updated' });
  } catch (e) { dupMsg(e); }
}));

// Photo upload (JPEG, PNG or WebP up to 2 MB). The file type is checked from its first bytes, not from the file name.
router.post('/:id/photo', requireAuth, requireRole('Admin'), upload.single('photo'), wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  if (!req.file) throw new HttpError(400, 'Choose an image file');
  const b = req.file.buffer;
  const type = b.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? ['jpg', 'image/jpeg']
    : b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? ['png', 'image/png']
      : b.slice(8, 12).toString() === 'WEBP' ? ['webp', 'image/webp'] : null;
  if (!type) throw new HttpError(400, 'Only JPEG, PNG or WebP images are accepted');
  const old = await db.one('SELECT photo_url FROM facilities WHERE facility_id = ?', [id]);
  if (!old) throw new HttpError(404, 'Facility not found');
  const key = await storage.put(`facilities/${id}-${Date.now()}.${type[0]}`, b, type[1]);
  await db.q('UPDATE facilities SET photo_url = ? WHERE facility_id = ?', [key, id]);
  storage.remove(old.photo_url).catch(() => {});
  audit(req, req.user.user_id, 'FACILITY_PHOTO', 'facilities', id);
  res.json({ photoSrc: await storage.url(key) });
}));

// DELETE (BR14): no bookings at all -> removed; has bookings -> set Inactive; future Confirmed bookings -> refused.
router.delete('/:id', requireAuth, requireRole('Admin'), wrap(async (req, res) => {
  const id = toInt(req.params.id, 'id');
  const fut = await db.one(
    `SELECT COUNT(*) AS c FROM bookings b JOIN time_slots ts ON ts.slot_id = b.slot_id
      WHERE b.facility_id = ? AND b.status = 'Confirmed' AND TIMESTAMP(b.booking_date, ts.end_time) > NOW()`, [id]);
  if (fut.c) throw new HttpError(409, `${fut.c} upcoming booking(s) exist. Cancel them first or set the facility to Inactive.`);
  const any = await db.one('SELECT COUNT(*) AS c FROM bookings WHERE facility_id = ?', [id]);
  if (any.c) {
    await db.q("UPDATE facilities SET status = 'Inactive' WHERE facility_id = ?", [id]);
    audit(req, req.user.user_id, 'FACILITY_DEACTIVATED', 'facilities', id);
    return res.json({ message: 'Facility has booking history, so it was set to Inactive', softDeleted: true });
  }
  const f = await db.one('SELECT photo_url FROM facilities WHERE facility_id = ?', [id]);
  const r = await db.q('DELETE FROM facilities WHERE facility_id = ?', [id]);
  if (!r.affectedRows) throw new HttpError(404, 'Facility not found');
  if (f) storage.remove(f.photo_url).catch(() => {});
  audit(req, req.user.user_id, 'FACILITY_DELETED', 'facilities', id);
  res.json({ message: 'Facility deleted' });
}));

module.exports = router;
