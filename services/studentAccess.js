// ─────────────────────────────────────────────────────────────────────
//  The student sign-in — ONE per real student (Person.login), for every
//  module the college has (training today; placement, prep, events later).
//
//  Before, the sign-in lived on each training record (Student.login, one per
//  batch). moveLogins() copies those onto the person once (and again for any
//  stragglers); sign-ins made before the move ({ sid }) keep working until they
//  expire, and every sign-out / reset ends them too (bump()).
//
//  Setup codes stay on the training record: the trainer of a batch hands them
//  out (personal codes) or shows the batch code — see routes/student.js.
// ─────────────────────────────────────────────────────────────────────
const jwt     = require('jsonwebtoken');
const Person  = require('../models/Person');
const Student = require('../models/Student');

const sign = (p) => jwt.sign({ pid: p._id, kind: 'student', org: p.org, v: p.login?.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '30d' });

// Copy old per-batch sign-ins onto people that have none yet (newest sign-in wins).
// all: every college (server start); otherwise the current one.
// personIds: only these people (a sign-in attempt), else everyone.
async function moveLogins({ all = false, personIds = null } = {}) {
  const opt = { withDemo: true, ...(all ? { allOrgs: true } : {}) };
  const recs = await Student.find({ person: personIds ? { $in: personIds } : { $ne: null }, 'login.passwordHash': { $ne: null } })
    .select('+login.passwordHash person login.activatedAt login.lastLoginAt').setOptions(opt).lean();   // (never a path and its parent together — MongoDB refuses that)
  if (!recs.length) return { moved: 0 };
  const people = await Person.find({ _id: { $in: [...new Set(recs.map(r => String(r.person)))] } })
    .select('+login.passwordHash').setOptions(all ? { allOrgs: true } : {}).lean();
  const needs = new Set(people.filter(p => !p.login?.passwordHash).map(p => String(p._id)));
  const best = new Map();
  for (const r of recs) {
    if (!needs.has(String(r.person))) continue;
    const cur = best.get(String(r.person));
    if (!cur || new Date(r.login.lastLoginAt || 0) > new Date(cur.login.lastLoginAt || 0)) best.set(String(r.person), r);
  }
  const ops = [...best.entries()].map(([pid, r]) => ({ updateOne: {
    filter: { _id: pid, 'login.passwordHash': null },
    update: { $set: { 'login.passwordHash': r.login.passwordHash, 'login.activatedAt': r.login.activatedAt || new Date(), 'login.lastLoginAt': r.login.lastLoginAt || null } },
  } }));
  if (ops.length) await Person.bulkWrite(ops, all ? { allOrgs: true } : {});
  return { moved: ops.length };
}

// End every sign-in of this person (new password, reset, sign out everywhere) —
// also the older per-batch sign-ins still around.
async function bump(personId) {
  await Person.updateOne({ _id: personId }, { $inc: { 'login.tokenVersion': 1 } });
  await Student.updateMany({ person: personId }, { $inc: { 'login.tokenVersion': 1 } }).setOptions({ withDemo: true });
}

// Sign-in status of the people behind these training records: Map studentId → { activated, lastLoginAt, personId }
async function statusOf(records) {
  const pids = [...new Set(records.map(r => r.person).filter(Boolean).map(String))];
  const people = pids.length ? await Person.find({ _id: { $in: pids } }).select('login.activatedAt login.lastLoginAt').lean() : [];
  const byId = new Map(people.map(p => [String(p._id), p]));
  return new Map(records.map(r => {
    const p = r.person && byId.get(String(r.person));
    return [String(r._id), { activated: !!p?.login?.activatedAt, lastLoginAt: p?.login?.lastLoginAt || null, personId: p?._id || null }];
  }));
}

// A person's training places (one per batch), best first: a place in the active
// semester, in an active batch, newest term. Plain rows for showing + choosing.
async function placesOf(personId, activeSemesterId) {
  const list = await Student.find({ person: personId }).select('batch semester createdAt').setOptions({ withDemo: true })
    .populate('batch', 'name track isActive').populate('semester', 'name status startDate').lean();
  const rank = (s) => (String(s.semester?._id) === String(activeSemesterId) ? 2 : 0) + (s.batch?.isActive !== false ? 1 : 0);
  return list.sort((a, b) => rank(b) - rank(a) || new Date(b.semester?.startDate || 0) - new Date(a.semester?.startDate || 0) || new Date(b.createdAt) - new Date(a.createdAt))
    .map(s => ({ studentId: String(s._id), batchId: String(s.batch?._id || ''), batch: s.batch?.name || '?', track: s.batch?.track || '',
      semester: s.semester?.name || '', current: String(s.semester?._id) === String(activeSemesterId) && s.batch?.isActive !== false }));
}

module.exports = { sign, moveLogins, bump, statusOf, placesOf };
