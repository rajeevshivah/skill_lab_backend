// ─────────────────────────────────────────────────────────────────────
//  One profile photo per student — set by the student on their dashboard
//  (or by a trainer on the batch page). It is the photo shown on the public
//  Hall of Fame whenever the student is in a cycle's Top 3:
//    • new Top 3 → takes the student's photo (services/topThree.js)
//    • student changes / removes the photo → every Top 3 they are in
//      (any cycle, open or closed) gets the new one, or none.
//  The Hall of Fame photo URL carries the cycle's last-change time, so
//  browsers fetch the new picture at once.
// ─────────────────────────────────────────────────────────────────────
const Student = require('../models/Student');
const Cycle = require('../models/Cycle');

const MAX_BYTES = 400 * 1024;          // the dashboard shrinks photos to ~30–60 KB first
const TYPES = /^image\/(jpeg|png|webp)$/;

// data URL → { data, contentType } | null (remove) ; throws on a bad image.
// maxBytes: 400 KB for profile photos; project screenshots pass their own limit.
function parse(dataUrl, maxBytes = MAX_BYTES) {
  if (dataUrl == null || dataUrl === '') return null;
  const m = String(dataUrl).match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !TYPES.test(m[1])) throw new Error('Use a JPG, PNG or WEBP photo.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw new Error(`Image is too large (max ${Math.round(maxBytes / 1024)} KB).`);
  // The bytes must really be that kind of image (it goes on a public page)
  const real = (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ? 'image/jpeg'
    : buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])) ? 'image/png'
    : (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') ? 'image/webp' : null;
  if (!real) throw new Error('That file is not a readable photo. Use a JPG, PNG or WEBP.');
  return { data: m[2], contentType: real };
}

// Copy the student's current photo into every Top 3 they appear in.
async function sync(studentId) {
  const s = await Student.findById(studentId).select('photo').lean();
  if (!s) return 0;
  const photo = s.photo?.data ? { data: s.photo.data, contentType: s.photo.contentType } : { data: null, contentType: null };
  const cycles = await Cycle.find({ 'report.top3.student': studentId });
  for (const c of cycles) {
    for (const t of c.report.top3) if (String(t.student) === String(studentId)) t.photo = photo;
    c.markModified('report');
    await c.save();                     // updatedAt changes → new photo URL on the Hall of Fame
  }
  return cycles.length;
}

async function set(studentId, dataUrl) {
  const p = parse(dataUrl);
  await Student.updateOne({ _id: studentId }, { $set: { photo: p || { data: null, contentType: null } } });
  return { hasPhoto: !!p, hallOfFame: await sync(studentId) };
}

module.exports = { parse, sync, set, MAX_BYTES };
