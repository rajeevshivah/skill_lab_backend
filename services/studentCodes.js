// Personal one-time setup codes for students (6 characters, no look-alikes).
const crypto = require('crypto');
const Student = require('../models/Student');
const Organization = require('../models/Organization');
const tenant = require('./tenant');

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const make = () => Array.from({ length: 6 }, () => CHARS[crypto.randomInt(CHARS.length)]).join('');

// 'personal' | 'batch' — the college's choice (Settings → Student sign-up)
async function mode() {
  const o = await Organization.findById(tenant.currentOrg()).select('settings.studentSignup').lean();
  return o?.settings?.studentSignup || 'personal';
}

// every not-yet-set-up student of these gets a code if they have none; returns Map id → code
async function ensure(studentIds) {
  const list = await Student.find({ _id: { $in: studentIds } }).select('+login.setupCode +login.passwordHash person').setOptions({ withDemo: true });
  const st = await require('./studentAccess').statusOf(list);   // set up = their main record has a sign-in
  const out = new Map(), ops = [];
  for (const s of list) {
    if (s.login?.passwordHash || st.get(String(s._id))?.activated) continue;
    let c = s.login?.setupCode;
    if (!c) { c = make(); ops.push({ updateOne: { filter: { _id: s._id }, update: { $set: { 'login.setupCode': c } } } }); }
    out.set(String(s._id), c);
  }
  if (ops.length) await Student.bulkWrite(ops);
  return out;
}

module.exports = { make, mode, ensure };
