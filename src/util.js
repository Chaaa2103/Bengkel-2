'use strict';
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function toInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a whole number`);
  return n;
}
function str(v, name, { min = 1, max = 255, optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${name} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${name} must be ${min} to ${max} characters`);
  return s;
}
const oneOf = (v, list, name) => {
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}`);
  return v;
};
const hhmm = (t) => String(t).slice(0, 5);
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // blocks CSV/Excel formula injection
  return `"${s.replace(/"/g, '""')}"`;
};

// Detects the real image type from the first bytes (never trust the file name or the browser's content type).
function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { ext: 'jpg', type: 'image/jpeg' };
  if (b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { ext: 'png', type: 'image/png' };
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

module.exports = { sniffImage, HttpError, wrap, isDate, toInt, str, oneOf, hhmm, csvCell };
