// ─────────────────────────────────────────────────────────────────────
//  Files people upload: resumes, marksheets, JD PDFs (models/Document.js).
//  Only real PDF / JPG / PNG files (checked by their first bytes, not the
//  name), at most 2 MB. Stored like photos (services/fileStore.js).
// ─────────────────────────────────────────────────────────────────────
const Document = require('../models/Document');
const fileStore = require('./fileStore');

const MAX_BYTES = 2 * 1024 * 1024;
class DocError extends Error {}

// first bytes → the real type
function sniff(buf) {
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// "data:application/pdf;base64,…" → { data (base64), contentType, size }
function parse(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new DocError('Upload a PDF, JPG or PNG file.');
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw new DocError('The file is empty.');
  if (buf.length > MAX_BYTES) throw new DocError('The file is too big — keep it under 2 MB.');
  const type = sniff(buf);
  if (!type) throw new DocError('Only PDF, JPG or PNG files can be uploaded.');
  return { data: buf.toString('base64'), contentType: type, size: buf.length };
}

const cleanName = (n, type) => {
  const base = String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 100) || 'file';
  const ext = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[type];
  return /\.[a-z0-9]{2,4}$/i.test(base) ? base : base + ext;
};

// Save an upload. owner = Person id (or null for a staff file).
async function save({ dataUrl, name, kind = 'other', owner = null, uploadedBy = null }) {
  const p = parse(dataUrl);
  const stored = await fileStore.store({ data: p.data, contentType: p.contentType }, 'docs');
  return Document.create({ owner, kind, name: cleanName(name, p.contentType), contentType: p.contentType, size: p.size,
    data: stored.data, key: stored.key, uploadedBy });
}

// The file's bytes (for downloads and the resume zip).
async function bytes(doc) {
  const full = doc.data !== undefined ? doc : await Document.findById(doc._id).select('+data').lean();
  return fileStore.read({ data: full.data, key: full.key, contentType: full.contentType });
}

const view = (d) => d ? { id: d._id, name: d.name, contentType: d.contentType, size: d.size, kind: d.kind, uploadedAt: d.createdAt } : null;

module.exports = { DocError, parse, save, bytes, view, MAX_BYTES };
