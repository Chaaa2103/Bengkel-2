'use strict';
// Files live in S3 (SSE-S3 encrypted, private, served through short-lived signed URLs). Without S3_BUCKET they go to ./data/uploads for local work.
const fs = require('fs/promises');
const path = require('path');
const { config } = require('../config');

const LOCAL_ROOT = path.join(__dirname, '..', '..', 'data', 'uploads');
let s3;
function client() {
  if (!s3) { const { S3Client } = require('@aws-sdk/client-s3'); s3 = new S3Client({ region: config.region }); }
  return s3;
}

async function put(key, body, contentType) {
  if (config.bucket) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await client().send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
    return key;
  }
  const file = path.join(LOCAL_ROOT, key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  return key;
}

async function url(key) {
  if (!key) return null;
  if (config.bucket) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    return getSignedUrl(client(), new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: 300 });
  }
  return `/local-files/${key}`;
}

async function remove(key) {
  if (!key) return;
  if (config.bucket) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await client().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  } else {
    await fs.rm(path.join(LOCAL_ROOT, key), { force: true });
  }
}

async function get(key) {
  if (!key) return null;
  try {
    if (config.bucket) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const out = await client().send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return Buffer.from(await out.Body.transformToByteArray());
    }
    return await fs.readFile(path.join(LOCAL_ROOT, key));
  } catch (_) { return null; }
}

// Used by the Monitoring page: can we reach the storage?
async function check() {
  if (!config.bucket) return { mode: 'local', ok: true };
  try {
    const { HeadBucketCommand } = require('@aws-sdk/client-s3');
    await client().send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { mode: 's3', ok: true };
  } catch (e) { return { mode: 's3', ok: false, error: e.name }; }
}

module.exports = { put, get, url, remove, check, LOCAL_ROOT };
