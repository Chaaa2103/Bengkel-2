'use strict';
// JSON lines to stdout. systemd appends them to /var/log/smartsports/app.log and the CloudWatch agent ships that file.
const write = (level, msg, extra) => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + '\n');
};
module.exports = {
  info: (m, x) => write('info', m, x),
  warn: (m, x) => write('warn', m, x),
  error: (m, x) => write('error', m, x),
};
