'use strict';
// Creates the tables, upgrades older databases, seeds the sports courts once, and makes sure an admin exists.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Courts of UTeM (counts from the group's list). Sport Hall extras are assumed to be 1 each. Admin can edit them in the app.
const COURTS = [
  { type: 'Badminton', base: 'Badminton Court', count: 5, location: 'UTeM Sport Hall', capacity: 4 },
  { type: 'Netball', base: 'Netball Court', count: 1, location: 'UTeM Sport Hall', capacity: 14 },
  { type: 'Football', names: ['Football Field A'], location: 'Outdoor Field', capacity: 22 },
  { type: 'Basketball', base: 'Basketball Court', count: 1, location: 'Luae Arena', capacity: 10 },
  { type: 'Sepak Takraw', base: 'Sepak Takraw Court', count: 2, location: 'Luae Arena', capacity: 6 },
  { type: 'Volleyball', base: 'Volleyball Court', count: 2, location: 'Outdoor Court', capacity: 12 },
  { type: 'Tennis', base: 'Tennis Court', count: 6, location: 'Outdoor Tennis Court', capacity: 4 },
  { type: 'Softball', base: 'Softball Field', count: 1, location: 'Outdoor Court', capacity: 18 },
  { type: 'Sepak Takraw', base: 'Hall Sepak Takraw Court', count: 1, location: 'UTeM Sport Hall', capacity: 6 },
  { type: 'Floorball', base: 'Hall Floorball Court', count: 1, location: 'UTeM Sport Hall', capacity: 12 },
  { type: 'Volleyball', base: 'Hall Volleyball Court', count: 1, location: 'UTeM Sport Hall', capacity: 12 },
  { type: 'Table Tennis', base: 'Hall Ping Pong Table', count: 1, location: 'UTeM Sport Hall', capacity: 4 },
];
const LEGACY = ['Outdoor Basketball Court', 'Futsal Arena A']; // courts from the first prototype

async function ensureColumn(pool, table, column, ddl) {
  const [[r]] = await pool.query(
    'SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  if (!r.c) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${column} ${ddl}`);
}

async function seedCourts(pool, log) {
  const [[done]] = await pool.query("SELECT COUNT(*) AS c FROM app_settings WHERE setting_key = 'courts_seed_v2'");
  if (done.c) return; // only once, so a court an admin deleted does not come back
  for (const name of LEGACY) { // remove first-prototype courts when nobody booked them
    const [[b]] = await pool.query('SELECT COUNT(*) AS c FROM bookings b JOIN facilities f ON f.facility_id = b.facility_id WHERE f.facility_name = ?', [name]);
    if (!b.c) await pool.query('DELETE FROM facilities WHERE facility_name = ?', [name]);
    else await pool.query("UPDATE facilities SET status = 'Inactive' WHERE facility_name = ?", [name]);
  }
  const [[m]] = await pool.query("SELECT COALESCE(MAX(CAST(SUBSTRING(thing_name, 7) AS UNSIGNED)), 0) AS n FROM iot_devices WHERE thing_name REGEXP '^RELAY_[0-9]+$'");
  let next = m.n + 1; let made = 0;
  for (const c of COURTS) {
    const names = c.names || Array.from({ length: c.count }, (_, i) => `${c.base} ${i + 1}`);
    for (const name of names) {
      await pool.query(
        "INSERT IGNORE INTO facilities (type_id, facility_name, location, capacity, status) SELECT type_id, ?, ?, ?, 'Active' FROM facility_types WHERE type_name = ?",
        [name, c.location, c.capacity, c.type]);
      const [[f]] = await pool.query('SELECT facility_id FROM facilities WHERE facility_name = ?', [name]);
      const [[d]] = await pool.query('SELECT COUNT(*) AS c FROM iot_devices WHERE facility_id = ?', [f.facility_id]);
      if (!d.c) { await pool.query('INSERT INTO iot_devices (facility_id, thing_name, firmware_version) VALUES (?,?,?)', [f.facility_id, `RELAY_${String(next++).padStart(2, '0')}`, '1.0.0']); made++; }
    }
  }
  await pool.query("INSERT INTO app_settings (setting_key, setting_value) VALUES ('courts_seed_v2', 'done')");
  log(`courts seeded (${made} new lighting devices)`);
}

async function initDb(pool, cfg, log = console.log) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').replace(/^--.*$/gm, '');
  const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  for (const s of statements) await pool.query(s);
  // upgrade databases created by the first prototype
  await ensureColumn(pool, 'users', 'phone', 'VARCHAR(20) NULL');
  await ensureColumn(pool, 'users', 'faculty', 'VARCHAR(100) NULL');
  await ensureColumn(pool, 'users', 'photo_url', 'VARCHAR(255) NULL');
  log(`schema ready (${statements.length} statements)`);

  await seedCourts(pool, log);

  const [[admin]] = await pool.query(
    "SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.role_id = u.role_id WHERE r.role_name = 'Admin'");
  if (!admin.c && cfg.admin.email && cfg.admin.password) {
    const hash = await bcrypt.hash(cfg.admin.password, 12);
    await pool.query(
      `INSERT INTO users (role_id, student_id, full_name, email, password_hash)
       SELECT role_id, 'ADMIN001', 'System Administrator', ?, ? FROM roles WHERE role_name = 'Admin'`,
      [cfg.admin.email.toLowerCase(), hash]);
    log(`admin account created: ${cfg.admin.email}`);
  }
  if (cfg.seedDemo) {
    const [[demo]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE student_id = 'B032510025'");
    if (!demo.c) {
      const hash = await bcrypt.hash('Student#12345', 12);
      await pool.query(
        `INSERT INTO users (role_id, student_id, full_name, email, password_hash)
         SELECT role_id, 'B032510025', 'Harith Uzair', 'b032510025@student.utem.edu.my', ? FROM roles WHERE role_name = 'Student'`,
        [hash]);
      log('demo student created: B032510025');
    }
  }
}

module.exports = { initDb };
