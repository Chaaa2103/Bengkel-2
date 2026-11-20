'use strict';
// Which web server answered? On EC2 this reads the instance id and Availability Zone (IMDSv2). Locally it is just the computer name.
const os = require('os');
let info = { hostname: os.hostname(), instanceId: null, az: null };

async function load() {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const tok = await (await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' }, signal: ctrl.signal })).text();
    const get = async (p) => (await fetch(`http://169.254.169.254/latest/meta-data/${p}`, { headers: { 'X-aws-ec2-metadata-token': tok }, signal: ctrl.signal })).text();
    info = { hostname: os.hostname(), instanceId: await get('instance-id'), az: await get('placement/availability-zone') };
  } catch (_) { /* not on EC2 */ } finally { clearTimeout(t); }
}
module.exports = { load, get: () => info };
