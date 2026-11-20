'use strict';
// A4-ish receipt (A5 portrait): navy header, optional court photo, details, QR code, notes. Stored in S3 (or ./data/uploads).
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const db = require('../db');
const storage = require('./storage');
const { hhmm } = require('../util');

const NAVY = '#0b1b2b'; const GREEN = '#0e9f6e'; const MINT = '#e3f6ee'; const GREY = '#5b6b79'; const LINE = '#d9e3e0'; const RED = '#cf3b3b';

async function render(b, photo) {
  const qr = await QRCode.toBuffer(`UTEMSPORTS|BOOKING|${b.booking_id}|${b.booking_date}|${hhmm(b.start_time)}-${hhmm(b.end_time)}|${b.facility_name}`, { margin: 1, width: 220 });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 0, info: { Title: `Booking receipt #${b.booking_id}`, Author: 'UTeM Smart Sports' } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width; const M = 32; const status = b.status;
    const sColor = status === 'Cancelled' ? RED : status === 'Completed' ? '#3b82c4' : GREEN;

    // header
    doc.rect(0, 0, W, 86).fill(NAVY);
    doc.roundedRect(M, 26, 34, 34, 8).fill(GREEN);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(20).text('U', M, 33, { width: 34, align: 'center' });
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(17).text('UTeM Smart Sports', M + 46, 26);
    doc.fillColor('#9fd3bf').font('Helvetica').fontSize(10).text('Booking receipt', M + 46, 48);
    doc.roundedRect(W - M - 84, 32, 84, 24, 12).fill(sColor);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10).text(status.toUpperCase(), W - M - 84, 39, { width: 84, align: 'center' });

    let y = 100;
    if (photo) { // court photo banner (JPEG or PNG only)
      try { doc.save().roundedRect(M, y, W - 2 * M, 96, 8).clip(); doc.image(photo, M, y, { cover: [W - 2 * M, 96], align: 'center', valign: 'center' }); doc.restore(); y += 108; } catch (_) { doc.restore(); }
    }
    doc.fillColor(GREY).font('Helvetica').fontSize(10).text(`Booking #${b.booking_id}`, M, y);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text(b.facility_name, M, y + 14, { width: W - 2 * M });
    y += 46;
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(14).text(`${b.booking_date}   ${hhmm(b.start_time)} - ${hhmm(b.end_time)}`, M, y);
    y += 30;
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 14;

    const rows = [['Name', b.full_name], ['Student ID', b.student_id], ['Location', b.location], ['Duration', '1 hour'], ['Booked on', String(b.created_at).slice(0, 16)]];
    const colW = 180; // keeps long names clear of the QR code
    rows.forEach(([k, v]) => {
      doc.fillColor(GREY).font('Helvetica').fontSize(9).text(k, M, y);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text(String(v), M + 78, y - 1, { width: colW });
      y += 22;
    });
    // QR
    const qrY = y - rows.length * 22 + 2;
    doc.image(qr, W - M - 86, qrY, { width: 86 });
    doc.fillColor(GREY).font('Helvetica').fontSize(7).text('Show at the court', W - M - 86, qrY + 88, { width: 86, align: 'center' });

    y = Math.max(y, qrY + 104) + 6;
    doc.roundedRect(M, y, W - 2 * M, 62, 8).fill(MINT);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('Good to know', M + 12, y + 9);
    doc.fillColor('#2c4a3e').font('Helvetica').fontSize(8.5)
      .text('The court lights switch on automatically a few minutes before your slot and off when it ends. A Telegram message tells you when the court is ready. You can change or cancel up to 2 hours before the slot starts.', M + 12, y + 23, { width: W - 2 * M - 24, lineGap: 1.5 });

    doc.rect(0, doc.page.height - 26, W, 26).fill(NAVY);
    doc.fillColor('#9fd3bf').font('Helvetica').fontSize(8).text(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}   |   Universiti Teknikal Malaysia Melaka`, M, doc.page.height - 17, { width: W - 2 * M, align: 'center' });
    if (status === 'Cancelled') {
      doc.save().rotate(-30, { origin: [W / 2, 300] }).fillColor(RED).opacity(0.16).font('Helvetica-Bold').fontSize(64).text('CANCELLED', 20, 270, { width: W - 40, align: 'center' }).restore();
    }
    doc.end();
  });
}

async function ensureReceipt(bookingId) {
  const b = await db.one(
    `SELECT b.booking_id, b.booking_date, b.status, b.created_at, b.receipt_url, u.full_name, u.student_id,
            f.facility_name, f.location, f.photo_url, ts.start_time, ts.end_time
       FROM bookings b JOIN users u ON u.user_id = b.user_id JOIN facilities f ON f.facility_id = b.facility_id
       JOIN time_slots ts ON ts.slot_id = b.slot_id WHERE b.booking_id = ?`, [bookingId]);
  if (!b) return null;
  if (b.receipt_url) return b.receipt_url;
  const photo = /\.(jpe?g|png)$/i.test(b.photo_url || '') ? await storage.get(b.photo_url) : null;
  const key = await storage.put(`receipts/booking-${bookingId}.pdf`, await render(b, photo), 'application/pdf');
  await db.q('UPDATE bookings SET receipt_url = ? WHERE booking_id = ?', [key, bookingId]);
  return key;
}
module.exports = { ensureReceipt };
