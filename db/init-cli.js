'use strict';
// npm run db:init  -> creates tables + seed data using the same config/secrets as the server.
const { load, config } = require('../src/config');
const db = require('../src/db');
const { initDb } = require('./init');

(async () => {
  await load();
  const pool = db.init(config);
  await initDb(pool, config);
  await pool.end();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
