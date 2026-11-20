'use strict';
// Central configuration. On AWS, secrets are read from AWS Secrets Manager at start-up (never stored in code or on disk).
require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

const config = {};

async function fetchSecret(arn, region) {
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region });
  const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(out.SecretString);
}

async function load() {
  const e = process.env;
  const region = e.AWS_REGION || e.AWS_DEFAULT_REGION || 'us-east-1';
  Object.assign(config, {
    env: e.NODE_ENV || 'development',
    port: num(e.PORT, 3000),
    region,
    tz: e.TZ_OFFSET || '+08:00',
    cookieSecure: bool(e.COOKIE_SECURE, false),
    rateLimitPerMin: num(e.RATE_LIMIT_PER_MIN, 300),
    db: {
      host: e.DB_HOST || 'localhost',
      port: num(e.DB_PORT, 3306),
      database: e.DB_NAME || 'smartsports',
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      sslCaPath: e.DB_SSL_CA || '',
    },
    sessionSecret: e.SESSION_SECRET || '',
    telegramToken: e.TELEGRAM_BOT_TOKEN || '',
    requireTelegram: bool(e.REQUIRE_TELEGRAM, false),
    allowedEmailDomain: (e.ALLOWED_EMAIL_DOMAIN || '').toLowerCase(),
    bucket: e.S3_BUCKET || '',
    autoInitDb: bool(e.AUTO_INIT_DB, false),
    seedDemo: bool(e.SEED_DEMO, false),
    admin: { email: e.ADMIN_EMAIL || '', password: e.ADMIN_PASSWORD || '' },
    iot: {
      mode: e.IOT_MODE || 'simulate',
      endpoint: e.IOT_ENDPOINT || '',
      cert: '', key: '', ca: '',
      leadMin: num(e.LIGHT_LEAD_MIN, 5),
      offlineAfterMin: num(e.OFFLINE_AFTER_MIN, 2),
      ackTimeoutSec: num(e.ACK_TIMEOUT_SEC, 20),
      schedulerSec: num(e.SCHEDULER_INTERVAL_SEC, 15),
      maxRetries: 3,
      simFailRate: num(e.SIM_FAIL_RATE, 0),
    },
    rules: {
      maxAdvanceDays: num(e.MAX_ADVANCE_DAYS, 7),
      maxPerDay: num(e.MAX_BOOKINGS_PER_DAY, 2),
      cancelCutoffHours: num(e.CANCEL_CUTOFF_HOURS, 2),
    },
    energy: {
      lightKw: num(e.LIGHT_KW, 1.0),
      gridEf: num(e.GRID_EF_KG_PER_KWH, 0.585),
      tariff: num(e.TARIFF_RM_PER_KWH, 0.5),
      openHour: 8,
      closeHour: 22,
    },
  });

  if (e.DB_SECRET_ARN) {
    const s = await fetchSecret(e.DB_SECRET_ARN, region);
    config.db.user = s.username;
    config.db.password = s.password;
  }
  if (e.APP_SECRET_ARN) {
    const s = await fetchSecret(e.APP_SECRET_ARN, region);
    config.sessionSecret = s.SESSION_SECRET || config.sessionSecret;
    config.telegramToken = s.TELEGRAM_BOT_TOKEN || config.telegramToken;
    config.admin.password = s.ADMIN_PASSWORD || config.admin.password;
  }
  if (e.IOT_SECRET_ARN) {
    const s = await fetchSecret(e.IOT_SECRET_ARN, region);
    Object.assign(config.iot, { cert: s.cert, key: s.key, ca: s.ca });
  }

  if (config.env === 'production' && config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }
  if (!config.sessionSecret) config.sessionSecret = require('crypto').randomBytes(32).toString('hex');
  if (!config.db.user || !config.db.password) throw new Error('Database credentials are missing');
  return config;
}

module.exports = { config, load };
