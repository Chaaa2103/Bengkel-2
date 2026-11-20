'use strict';
// Sets a new password for any account (use it when the admin password is lost).
//   node scripts/reset-password.js admin@utem.edu.my "Admin#12345"
// It reads the same .env / AWS settings as the server.
const bcrypt = require('bcryptjs');
const { load, config } = require('../src/config');
const db = require('../src/db');

(async () => {
  const [, , who, pw] = process.argv;
  if (!who || !pw) { console.error('Usage: node scripts/reset-password.js <email or student ID> "<new password>"'); process.exit(1); }
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) { console.error('Password needs at least 8 characters with letters and numbers'); process.exit(1); }
  await load();
  const pool = db.init(config);
  const [r] = await pool.query('UPDATE users SET password_hash = ?, status = \'Active\' WHERE email = ? OR student_id = ?',
    [await bcrypt.hash(pw, 12), who.toLowerCase(), who.toUpperCase()]);
  console.log(r.affectedRows ? `Password updated for ${who}. You can log in now.` : `No account found for ${who}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
