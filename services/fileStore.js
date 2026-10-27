// ─────────────────────────────────────────────────────────────────────
//  Where images live: Cloudflare R2 (or any S3-compatible storage) when it is
//  set up, otherwise inside the database record as before. Records keep
//  { data, contentType, key }: `key` = the file's name in storage, `data` =
//  base64 kept in the record. Everything reads through has() / read() /
//  publicUrl(), so both kinds work side by side (old images stay readable).
//
//  Set up (Render → Environment):
//    FILES_ENDPOINT   https://<account id>.r2.cloudflarestorage.com
//    FILES_BUCKET     e.g. pramakra-files
//    FILES_KEY_ID / FILES_SECRET   an R2 API token (Object Read & Write)
//    FILES_PUBLIC_URL the bucket's public address (r2.dev or your domain),
//                     used for photos shown on the public Hall of Fame
//  Screenshots are never linked publicly: the server fetches and sends them.
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const tenant = require('./tenant');

let client = null;
const env = () => ({ endpoint: process.env.FILES_ENDPOINT, bucket: process.env.FILES_BUCKET,
  id: process.env.FILES_KEY_ID, secret: process.env.FILES_SECRET, pub: (process.env.FILES_PUBLIC_URL || '').replace(/\/+$/, '') });
const enabled = () => { const e = env(); return !!(e.endpoint && e.bucket && e.id && e.secret); };
function s3() {
  if (!client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const e = env();
    client = new S3Client({ region: 'auto', endpoint: e.endpoint, credentials: { accessKeyId: e.id, secretAccessKey: e.secret } });
  }
  return client;
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// { data(base64), contentType } → what the record stores. folder: photos | top3 | screens
async function store(parsed, folder) {
  if (!parsed?.data) return { data: null, contentType: null, key: null };
  if (!enabled()) return { data: parsed.data, contentType: parsed.contentType, key: null };
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const key = `${tenant.currentOrg() || 'platform'}/${folder}/${crypto.randomBytes(12).toString('hex')}.${EXT[parsed.contentType] || 'bin'}`;
  await s3().send(new PutObjectCommand({ Bucket: env().bucket, Key: key, Body: Buffer.from(parsed.data, 'base64'),
    ContentType: parsed.contentType, CacheControl: 'public, max-age=31536000, immutable' }));
  return { data: null, contentType: parsed.contentType, key };
}

const has = (f) => !!(f && f.contentType && (f.data || f.key));

// the image bytes, wherever they are (null when none)
async function read(f) {
  if (!has(f)) return null;
  if (f.data) return Buffer.from(f.data, 'base64');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await s3().send(new GetObjectCommand({ Bucket: env().bucket, Key: f.key }));
  return Buffer.from(await out.Body.transformToByteArray());
}
const dataUrl = async (f) => { const b = await read(f); return b ? `data:${f.contentType};base64,${b.toString('base64')}` : null; };

// a direct address for a stored file (photos only), when the bucket is public
const publicUrl = (f) => (f?.key && env().pub ? `${env().pub}/${f.key}` : null);

// best effort: a replaced or removed file is deleted from storage
async function remove(f) {
  if (!f?.key || !enabled()) return;
  try { const { DeleteObjectCommand } = require('@aws-sdk/client-s3'); await s3().send(new DeleteObjectCommand({ Bucket: env().bucket, Key: f.key })); }
  catch (e) { console.error('[files] delete failed', f.key, e.message); }
}

module.exports = { enabled, store, has, read, dataUrl, publicUrl, remove };
