'use strict';
// Reports for admins: frequency tables, statistics, complex queries (JOIN, GROUP BY / HAVING, window functions, NOT EXISTS)
// and the SDG 7 / 13 energy estimate from the IoT lighting feature.
const express = require('express');
const { config } = require('../config');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { wrap, HttpError, isDate, csvCell, hhmm } = require('../util');
const { audit } = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireRole('Admin'));

const USED = "('Confirmed','Completed')";

async function range(req) {
  let { from, to } = req.query;
  if (!from || !to) {
    const d = await db.one("SELECT DATE_FORMAT(CURDATE() - INTERVAL 29 DAY, '%Y-%m-%d') AS f, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS t");
    from = from || d.f; to = to || d.t;
  }
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, 'Dates must look like 2026-11-05');
  if (from > to) throw new HttpError(400, 'Start date must be on or before the end date'); // BR23
  const days = (await db.one('SELECT DATEDIFF(?, ?) + 1 AS n', [to, from])).n;
  if (days > 366) throw new HttpError(400, 'Choose a range of one year or less');
  return { from, to, days };
}

async function summary({ from, to, days }) {
  const s = await db.one(
    `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'Confirmed'), 0) AS confirmed, COALESCE(SUM(status = 'Completed'), 0) AS completed,
            COALESCE(SUM(status = 'Cancelled'), 0) AS cancelled, COUNT(DISTINCT user_id) AS active_users
       FROM bookings WHERE booking_date BETWEEN ? AND ?`, [from, to]);
  const cap = await db.one(
    "SELECT (SELECT COUNT(*) FROM facilities WHERE status = 'Active') AS facilities, (SELECT COUNT(*) FROM time_slots) AS slots");
  const used = s.confirmed + s.completed;
  const capacity = cap.facilities * cap.slots * days;
  const { lightKw, gridEf, tariff, openHour, closeHour } = config.energy;
  const iotFac = (await db.one("SELECT COUNT(*) AS n FROM facilities f JOIN iot_devices d ON d.facility_id = f.facility_id WHERE f.status = 'Active'")).n;
  const onHours = (await db.one(
    `SELECT COALESCE(SUM(TIMESTAMPDIFF(MINUTE, ts.start_time, ts.end_time) + ?), 0) / 60 AS h
       FROM bookings b JOIN time_slots ts ON ts.slot_id = b.slot_id JOIN iot_devices d ON d.facility_id = b.facility_id
      WHERE b.status IN ${USED} AND b.booking_date BETWEEN ? AND ?`, [config.iot.leadMin, from, to])).h;
  const baseline = iotFac * (closeHour - openHour) * days; // lights that would stay on all day without automation
  const saved = Math.max(0, baseline - onHours);
  const kwh = saved * lightKw;
  return {
    range: { from, to, days },
    bookings: { total: s.total, confirmed: s.confirmed, completed: s.completed, cancelled: s.cancelled },
    active_users: s.active_users,
    cancellation_rate_pct: s.total ? Math.round((1000 * s.cancelled) / s.total) / 10 : 0,
    avg_bookings_per_day: Math.round((10 * used) / days) / 10,
    utilization_pct: capacity ? Math.round((1000 * used) / capacity) / 10 : 0,
    energy: {
      lights_on_hours: Math.round(onHours * 10) / 10, always_on_hours: baseline, hours_saved: Math.round(saved * 10) / 10,
      kwh_saved: Math.round(kwh * 10) / 10, co2_kg_avoided: Math.round(kwh * gridEf * 10) / 10, rm_saved: Math.round(kwh * tariff * 100) / 100,
      assumptions: { lightKw, gridEf_kg_per_kwh: gridEf, tariff_rm_per_kwh: tariff, open: `${openHour}:00`, close: `${closeHour}:00` },
    },
  };
}

async function byFacility({ from, to, days }) {
  // Window function RANK() over an aggregate ranks courts by used slots.
  return db.q(
    `SELECT f.facility_id, f.facility_name, ft.type_name, COUNT(b.booking_id) AS bookings,
            COALESCE(SUM(b.status IN ${USED}), 0) AS used_slots, COALESCE(SUM(b.status = 'Cancelled'), 0) AS cancelled,
            ROUND(100 * COALESCE(SUM(b.status IN ${USED}), 0) / ((SELECT COUNT(*) FROM time_slots) * ?), 1) AS utilization_pct,
            RANK() OVER (ORDER BY COALESCE(SUM(b.status IN ${USED}), 0) DESC) AS usage_rank
       FROM facilities f JOIN facility_types ft ON ft.type_id = f.type_id
       LEFT JOIN bookings b ON b.facility_id = f.facility_id AND b.booking_date BETWEEN ? AND ?
      GROUP BY f.facility_id, f.facility_name, ft.type_name ORDER BY usage_rank, f.facility_name`, [days, from, to]);
}
const byHour = ({ from, to }) => db.q(
  `SELECT HOUR(ts.start_time) AS hour, COUNT(*) AS bookings FROM bookings b JOIN time_slots ts ON ts.slot_id = b.slot_id
    WHERE b.status IN ${USED} AND b.booking_date BETWEEN ? AND ? GROUP BY HOUR(ts.start_time) ORDER BY hour`, [from, to]);
const byWeekday = ({ from, to }) => db.q(
  `SELECT WEEKDAY(booking_date) AS dow, DAYNAME(booking_date) AS day_name, COUNT(*) AS bookings FROM bookings
    WHERE status IN ${USED} AND booking_date BETWEEN ? AND ? GROUP BY WEEKDAY(booking_date), DAYNAME(booking_date) ORDER BY dow`, [from, to]);
const byDay = ({ from, to }) => db.q(
  `SELECT booking_date AS day, COUNT(*) AS bookings, SUM(status = 'Cancelled') AS cancelled FROM bookings
    WHERE booking_date BETWEEN ? AND ? GROUP BY booking_date ORDER BY booking_date`, [from, to]);
// GROUP BY ... HAVING: students with the most bookings and their cancellation share.
const topUsers = ({ from, to }) => db.q(
  `SELECT u.student_id, u.full_name, COUNT(*) AS bookings, SUM(b.status = 'Cancelled') AS cancelled,
          ROUND(100 * SUM(b.status = 'Cancelled') / COUNT(*), 1) AS cancel_pct
     FROM bookings b JOIN users u ON u.user_id = b.user_id WHERE b.booking_date BETWEEN ? AND ?
    GROUP BY u.user_id, u.student_id, u.full_name HAVING COUNT(*) >= 1 ORDER BY bookings DESC, u.full_name LIMIT 10`, [from, to]);
// ROW_NUMBER() per facility: each court's busiest time slot.
const peakSlots = ({ from, to }) => db.q(
  `SELECT facility_name, start_time, bookings FROM (
     SELECT f.facility_name, ts.start_time, COUNT(*) AS bookings,
            ROW_NUMBER() OVER (PARTITION BY f.facility_id ORDER BY COUNT(*) DESC, ts.start_time) AS rn
       FROM bookings b JOIN facilities f ON f.facility_id = b.facility_id JOIN time_slots ts ON ts.slot_id = b.slot_id
      WHERE b.status IN ${USED} AND b.booking_date BETWEEN ? AND ? GROUP BY f.facility_id, f.facility_name, ts.slot_id, ts.start_time) x
   WHERE rn = 1 ORDER BY facility_name`, [from, to]);
// NOT EXISTS: active facilities nobody booked in the period.
const unused = ({ from, to }) => db.q(
  `SELECT f.facility_name FROM facilities f WHERE f.status = 'Active'
     AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.facility_id = f.facility_id AND b.status IN ${USED} AND b.booking_date BETWEEN ? AND ?)`, [from, to]);

router.get('/overview', wrap(async (req, res) => {
  const r = await range(req);
  const [sum, fac, hour, wd, day, users, peak, none] = await Promise.all([
    summary(r), byFacility(r), byHour(r), byWeekday(r), byDay(r), topUsers(r), peakSlots(r), unused(r)]);
  audit(req, req.user.user_id, 'REPORT_VIEWED', 'reports', null);
  res.json({ summary: sum, by_facility: fac, by_hour: hour, by_weekday: wd, by_day: day, top_users: users,
    peak_slots: peak.map((p) => ({ ...p, start_time: hhmm(p.start_time) })), unused_facilities: none.map((n) => n.facility_name) });
}));

router.get('/frequency', wrap(async (req, res) => {
  const r = await range(req);
  const fn = { facility: byFacility, hour: byHour, weekday: byWeekday, day: byDay }[req.query.by || 'facility'];
  if (!fn) throw new HttpError(400, 'by must be facility, hour, weekday or day');
  res.json(await fn(r));
}));

router.get('/export.csv', wrap(async (req, res) => {
  const r = await range(req);
  const rows = await db.q(
    `SELECT b.booking_id, b.booking_date, ts.start_time, ts.end_time, f.facility_name, u.student_id, u.full_name, b.status, b.created_at
       FROM bookings b JOIN facilities f ON f.facility_id = b.facility_id JOIN users u ON u.user_id = b.user_id JOIN time_slots ts ON ts.slot_id = b.slot_id
      WHERE b.booking_date BETWEEN ? AND ? ORDER BY b.booking_date, ts.start_time, f.facility_name`, [r.from, r.to]);
  const head = ['Booking ID', 'Date', 'Start', 'End', 'Facility', 'Student ID', 'Name', 'Status', 'Created'];
  const lines = [head.map(csvCell).join(',')].concat(rows.map((x) =>
    [x.booking_id, x.booking_date, hhmm(x.start_time), hhmm(x.end_time), x.facility_name, x.student_id, x.full_name, x.status, x.created_at].map(csvCell).join(',')));
  audit(req, req.user.user_id, 'REPORT_EXPORTED', 'reports', null);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bookings_${r.from}_to_${r.to}.csv"`);
  res.send(`\ufeff${lines.join('\r\n')}`);
}));

module.exports = router;
