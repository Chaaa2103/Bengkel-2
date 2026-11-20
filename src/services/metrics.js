'use strict';
// In-memory request statistics for the Monitoring page (per web server). CloudWatch holds the long-term numbers.
const buckets = new Map(); // minute (epoch) -> { req, e4, e5, ms }
const errors = [];
const started = Date.now();
let total = { req: 0, e4: 0, e5: 0 };

function record(status, ms) {
  const m = Math.floor(Date.now() / 60000);
  const b = buckets.get(m) || { req: 0, e4: 0, e5: 0, ms: 0 };
  b.req++; b.ms += ms; total.req++;
  if (status >= 500) { b.e5++; total.e5++; } else if (status >= 400) { b.e4++; total.e4++; }
  buckets.set(m, b);
  for (const k of buckets.keys()) if (k < m - 60) buckets.delete(k);
}
function recordError(path, msg) { errors.unshift({ at: new Date().toISOString(), path, msg: String(msg).slice(0, 200) }); errors.length = Math.min(errors.length, 20); }

function snapshot(minutes = 30) {
  const now = Math.floor(Date.now() / 60000); const series = [];
  for (let m = now - minutes + 1; m <= now; m++) {
    const b = buckets.get(m) || { req: 0, e4: 0, e5: 0, ms: 0 };
    series.push({ minute: new Date(m * 60000).toISOString().slice(11, 16), requests: b.req, errors: b.e5, client_errors: b.e4, avg_ms: b.req ? Math.round(b.ms / b.req) : 0 });
  }
  const sum = series.reduce((a, x) => ({ r: a.r + x.requests, ms: a.ms + x.avg_ms * x.requests }), { r: 0, ms: 0 });
  return { series, totals: total, avg_ms_window: sum.r ? Math.round(sum.ms / sum.r) : 0, uptime_sec: Math.round((Date.now() - started) / 1000), recent_errors: errors };
}
module.exports = { record, recordError, snapshot };
