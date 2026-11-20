'use strict';
const fs = require('fs');
const mysql = require('mysql2/promise');

let pool;

function init(cfg) {
  const ssl = cfg.db.sslCaPath
    ? { ca: fs.readFileSync(cfg.db.sslCaPath), rejectUnauthorized: true } // encrypted + verified connection to RDS
    : undefined;
  pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 200,
    timezone: cfg.tz,
    dateStrings: true,
    decimalNumbers: true,
    ssl,
  });
  pool.pool.on('connection', (c) => c.query(`SET time_zone = '${cfg.tz}'`));
  return pool;
}

const q = async (sql, params = []) => (await pool.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0] || null;

async function tx(fn) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    try { await c.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

const ping = async () => { await pool.query('SELECT 1'); return true; };

module.exports = { init, q, one, tx, ping, getPool: () => pool };
