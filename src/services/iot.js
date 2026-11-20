'use strict';
// IoT gateway. mode=aws: MQTT over TLS (port 8883) to AWS IoT Core with an X.509 certificate.
// mode=simulate: built-in fake ESP32 devices so the whole flow can be demonstrated without hardware.
const { config } = require('../config');
const db = require('../db');
const log = require('../logger');
const notify = require('./notify');
const { audit } = require('./audit');

let client = null;
let simTimer = null;
const base = (thing) => `utem/sports/court/${thing}`;

async function start() {
  const c = config.iot;
  if (c.mode === 'aws' && c.endpoint && c.cert && c.key) {
    const mqtt = require('mqtt');
    client = mqtt.connect(`mqtts://${c.endpoint}:8883`, {
      clientId: `smartsports-backend-${process.pid}-${Date.now() % 100000}`,
      cert: c.cert, key: c.key, ca: c.ca || undefined,
      reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 30, rejectUnauthorized: true,
    });
    client.on('connect', () => {
      client.subscribe(['utem/sports/court/+/ack', 'utem/sports/court/+/heartbeat'], { qos: 1 });
      log.info('iot_connected', { endpoint: c.endpoint });
    });
    client.on('message', (topic, buf) => onMessage(topic, buf).catch((e) => log.error('iot_message_failed', { msg: e.message })));
    client.on('error', (e) => log.error('iot_error', { msg: e.message }));
    return 'aws';
  }
  log.info('iot_simulation_mode');
  const beat = async () => {
    const devs = await db.q('SELECT thing_name FROM iot_devices');
    for (const d of devs) if (Math.random() >= 0.02) await handleHeartbeat(d.thing_name);
  };
  simTimer = setInterval(() => beat().catch(() => {}), 20000);
  beat().catch(() => {});
  return 'simulate';
}
function stop() { if (simTimer) clearInterval(simTimer); if (client) client.end(true); }
const mode = () => (client ? 'aws' : 'simulate');

async function onMessage(topic, buf) {
  const [, , , thing, kind] = topic.split('/');
  let p = {};
  try { p = JSON.parse(buf.toString()); } catch (_) { return; }
  if (kind === 'ack') await handleAck(thing, p);
  else if (kind === 'heartbeat') await handleHeartbeat(thing, p);
}

function publish(thing, payload) {
  if (client) {
    return new Promise((resolve, reject) => {
      if (!client.connected) return reject(new Error('MQTT client not connected'));
      client.publish(`${base(thing)}/cmd`, JSON.stringify(payload), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }
  // Simulated ESP32: acknowledges after a short delay, unless SIM_FAIL_RATE drops the ACK (to demo retries).
  if (Math.random() >= config.iot.simFailRate) {
    setTimeout(() => handleAck(thing, { cmdId: payload.cmdId, state: payload.command }).catch(() => {}), 300 + Math.random() * 400);
  }
  return Promise.resolve();
}

// Sends ON/OFF. bookingId is null for manual admin overrides.
async function sendCommand({ device, command, bookingId = null }) {
  const prior = bookingId
    ? await db.one("SELECT COUNT(*) AS c FROM light_command_logs WHERE booking_id = ? AND command_type = ? AND ack_status = 'Failed'", [bookingId, command])
    : { c: 0 };
  const r = await db.q(
    "INSERT INTO light_command_logs (booking_id, device_id, command_type, sent_at, ack_status, retry_count) VALUES (?,?,?,NOW(),'Pending',?)",
    [bookingId, device.device_id, command, prior.c]);
  const cmdId = r.insertId;
  try {
    await publish(device.thing_name, { cmdId, command, bookingId, ts: Date.now() });
  } catch (e) {
    await db.q("UPDATE light_command_logs SET ack_status = 'Failed' WHERE command_id = ?", [cmdId]);
    log.warn('iot_publish_failed', { thing: device.thing_name, msg: e.message });
  }
  return cmdId;
}

async function handleAck(thing, p) {
  const state = p.state === 'ON' ? 'ON' : p.state === 'OFF' ? 'OFF' : null;
  if (!state || !Number.isInteger(Number(p.cmdId))) return;
  const dev = await db.one('SELECT device_id FROM iot_devices WHERE thing_name = ?', [thing]);
  if (!dev) return;
  const res = await db.q(
    "UPDATE light_command_logs SET ack_status = 'Acknowledged', ack_at = NOW() WHERE command_id = ? AND device_id = ? AND ack_status IN ('Pending','Failed')",
    [Number(p.cmdId), dev.device_id]);
  if (!res.affectedRows) return; // already handled (for example by another web server)
  await db.q("UPDATE iot_devices SET light_state = ?, last_seen = NOW(), status = 'Online' WHERE device_id = ?", [state, dev.device_id]);
  const cmd = await db.one('SELECT booking_id, command_type FROM light_command_logs WHERE command_id = ?', [Number(p.cmdId)]);
  audit(null, null, `LIGHT_${state}`, 'iot_devices', dev.device_id);
  if (cmd && cmd.command_type === 'ON' && cmd.booking_id) await notify.courtReady(cmd.booking_id); // BR21: only after the ACK
}

async function handleHeartbeat(thing, p = {}) {
  const dev = await db.one('SELECT device_id, status FROM iot_devices WHERE thing_name = ?', [thing]);
  if (!dev) return;
  const fw = typeof p.fw === 'string' ? p.fw.slice(0, 20) : null;
  await db.q("UPDATE iot_devices SET last_seen = NOW(), status = 'Online', firmware_version = COALESCE(?, firmware_version) WHERE device_id = ?", [fw, dev.device_id]);
  if (dev.status !== 'Online') {
    await db.q("INSERT INTO device_status_logs (device_id, status, recorded_at) VALUES (?, 'Online', NOW())", [dev.device_id]);
  }
}

module.exports = { start, stop, mode, sendCommand, handleAck, handleHeartbeat };
