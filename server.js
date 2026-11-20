'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { load, config } = require('./src/config');
const db = require('./src/db');
const log = require('./src/logger');
const { csrfGuard } = require('./src/middleware/auth');
const iot = require('./src/services/iot');
const scheduler = require('./src/services/scheduler');
const metrics = require('./src/services/metrics');
const instance = require('./src/services/instance');

async function main() {
  await load();
  const pool = db.init(config);
  if (config.autoInitDb) await require('./db/init').initDb(pool, config, (m) => log.info(m));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // one hop: the Application Load Balancer

  app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true },
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://*.amazonaws.com'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: config.cookieSecure ? [] : null,
    } },
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '100kb' }));

  // Health checks for the load balancer. /health also proves the database is reachable.
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health', async (_req, res) => {
    try { await db.ping(); res.json({ status: 'ok', db: 'up', iot: iot.mode(), uptime: Math.round(process.uptime()) }); }
    catch (e) { log.error('health_failed', { msg: e.message }); res.status(503).json({ status: 'down', db: 'down' }); }
  });

  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: config.rateLimitPerMin, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests. Slow down a little.' } }));
  app.use('/api', csrfGuard);
  app.use('/api', (req, res, next) => { const t0 = Date.now(); res.on('finish', () => metrics.record(res.statusCode, Date.now() - t0)); next(); });

  app.use('/api/auth', require('./src/routes/auth'));
  app.use('/api/facilities', require('./src/routes/facilities'));
  app.use('/api/bookings', require('./src/routes/bookings'));
  app.use('/api/reports', require('./src/routes/reports'));
  app.use('/api/devices', require('./src/routes/devices'));
  app.use('/api/admin', require('./src/routes/admin'));
  app.use('/api/notifications', require('./src/routes/notifications'));
  app.get('/api/time-slots', async (_req, res, next) => {
    try { res.json((await db.q('SELECT slot_id, start_time, end_time FROM time_slots ORDER BY start_time')).map((s) => ({ slot_id: s.slot_id, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) }))); }
    catch (e) { next(e); }
  });
  app.get('/api/config', (_req, res) => res.json({ rules: config.rules, leadMin: config.iot.leadMin, iotMode: iot.mode(), requireTelegram: config.requireTelegram }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  if (!config.bucket) app.use('/local-files', express.static(require('./src/services/storage').LOCAL_ROOT, { index: false }));
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: config.env === 'production' ? '1h' : 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) { log.error('request_failed', { path: req.path, msg: err.message }); metrics.recordError(req.path, err.message); }
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message });
  });

  const server = app.listen(config.port, () => log.info('server_started', { port: config.port, env: config.env }));
  instance.load().catch(() => {});
  await iot.start();
  scheduler.start();

  // Graceful stop so auto scaling can remove an instance without dropping requests.
  const stop = (sig) => {
    log.info('shutdown', { sig });
    scheduler.stop(); iot.stop();
    server.close(async () => { try { await db.getPool().end(); } finally { process.exit(0); } });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e) => { log.error('startup_failed', { msg: e.message }); process.exit(1); });
