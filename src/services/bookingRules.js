'use strict';
// Business rules BR07 to BR12 in one place so create and reschedule behave the same way.
const { config } = require('../config');
const { HttpError } = require('../util');

async function validateSlot(conn, { userId, facilityId, slotId, date, excludeBookingId = 0 }) {
  // Serialise bookings of the same user so the daily limit cannot be bypassed by two parallel requests.
  await conn.query('SELECT user_id FROM users WHERE user_id = ? FOR UPDATE', [userId]);
  const [[fac]] = await conn.query('SELECT facility_id, facility_name, status FROM facilities WHERE facility_id = ?', [facilityId]);
  if (!fac) throw new HttpError(404, 'Facility not found');
  if (fac.status !== 'Active') throw new HttpError(409, 'This facility is not open for booking');
  const [[slot]] = await conn.query('SELECT slot_id, start_time, end_time FROM time_slots WHERE slot_id = ?', [slotId]);
  if (!slot) throw new HttpError(404, 'Time slot not found');

  const [[chk]] = await conn.query(
    'SELECT DATEDIFF(?, CURDATE()) AS diff, (TIMESTAMP(?, ?) > NOW()) AS future', [date, date, slot.start_time]);
  if (chk.diff < 0) throw new HttpError(400, 'Booking date cannot be in the past');
  if (chk.diff > config.rules.maxAdvanceDays) throw new HttpError(400, `Bookings open up to ${config.rules.maxAdvanceDays} days ahead`);
  if (!chk.future) throw new HttpError(400, 'This slot has already started');

  const [[cnt]] = await conn.query(
    "SELECT COUNT(*) AS c FROM bookings WHERE user_id = ? AND booking_date = ? AND status = 'Confirmed' AND booking_id <> ?",
    [userId, date, excludeBookingId]);
  if (cnt.c >= config.rules.maxPerDay) throw new HttpError(409, `Limit reached: maximum ${config.rules.maxPerDay} bookings per day`);
  return { fac, slot };
}
module.exports = { validateSlot };
