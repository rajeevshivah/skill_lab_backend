// ─────────────────────────────────────────────────────────────────────
//  /api/academics — the college's academic structure, shared by every
//  module: programmes (with branches) and cohorts (programme + admission
//  year, with sections). Admin changes; management (viewer) reads.
//  Nothing is deleted: switch off with isActive=false.
// ─────────────────────────────────────────────────────────────────────
const express   = require('express');
const mongoose  = require('mongoose');
const Programme = require('../models/Programme');
const Cohort    = require('../models/Cohort');
const Person    = require('../models/Person');
const { protect, superadminOnly } = require('../middleware/auth');
const router    = express.Router();

const readers = (req, res, next) => ['superadmin', 'viewer', 'placement'].includes(req.user.role) ? next() : res.status(403).json({ message: 'Admin, placement or management only' });
const oid = (v) => mongoose.isValidObjectId(v);
const fail = (res, err) => res.status(err.name === 'ValidationError' || err.code === 11000 || err.status === 400 ? 400 : 500)
  .json({ message: err.code === 11000 ? 'That already exists.' : err.message });
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const code = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

router.use(protect);

// GET /api/academics — programmes, cohorts, and how many students each has
router.get('/', readers, async (req, res) => {
  try {
    const [programmes, cohorts, counts] = await Promise.all([
      Programme.find({}).sort('name').lean(),
      Cohort.find({}).sort('-admissionYear name').lean(),
      Person.aggregate([{ $match: { demo: { $ne: true } } }, { $group: { _id: '$academic.cohort', n: { $sum: 1 } } }]),
    ]);
    const n = new Map(counts.map(c => [String(c._id), c.n]));
    res.json({
      programmes,
      cohorts: cohorts.map(c => ({ ...c, students: n.get(String(c._id)) || 0 })),
      withoutCohort: n.get('null') || 0,
    });
  } catch (err) { fail(res, err); }
});

const branchesIn = (list) => {
  if (!Array.isArray(list)) throw bad('branches must be a list');
  const seen = new Set();
  return list.map(b => {
    const c = code(b.code);
    if (!c || !String(b.name || '').trim()) throw bad('Each branch needs a code and a name.');
    if (seen.has(c)) throw bad(`Branch ${c} is listed twice.`);
    seen.add(c);
    return { code: c, name: String(b.name).trim(), isActive: b.isActive !== false };
  });
};
const programmeInput = (b) => {
  const out = {};
  for (const k of ['name', 'level', 'durationYears', 'termsPerYear', 'department', 'isActive']) if (b[k] !== undefined) out[k] = b[k];
  if (b.branches !== undefined) out.branches = branchesIn(b.branches);
  if (b.aliases !== undefined) out.aliases = [...new Set((b.aliases || []).map(code).filter(Boolean))].slice(0, 20);
  return out;
};

// POST /api/academics/programmes  { name, code, level, durationYears, termsPerYear, department, branches[], aliases[] }
router.post('/programmes', superadminOnly, async (req, res) => {
  try {
    const c = code(req.body.code || req.body.name);
    if (!c) throw bad('A programme needs a code (e.g. BTECH).');
    const p = await Programme.create({ code: c, ...programmeInput(req.body), createdBy: req.user._id });
    res.status(201).json({ programme: p });
  } catch (err) { fail(res, err); }
});

// PATCH /api/academics/programmes/:id — the code stays (imports match on it); add old spellings to aliases
router.patch('/programmes/:id', superadminOnly, async (req, res) => {
  try {
    if (!oid(req.params.id)) throw bad('Bad id');
    const p = await Programme.findById(req.params.id);
    if (!p) return res.status(404).json({ message: 'Programme not found' });
    const next = programmeInput(req.body);
    if (next.branches) {   // a branch students are in cannot disappear (switch it off instead)
      const used = await Person.distinct('academic.branch', { 'academic.programme': p._id });
      const gone = used.filter(b => b && !next.branches.some(x => x.code === b));
      if (gone.length) throw bad(`Students are in branch ${gone.join(', ')} — switch it off (isActive false) instead of removing it.`);
    }
    p.set(next);
    await p.save();
    res.json({ programme: p });
  } catch (err) { fail(res, err); }
});

const sectionsIn = (list) => {
  if (!Array.isArray(list)) throw bad('sections must be a list');
  const out = [];
  for (const s of list) {
    const c = code(typeof s === 'string' ? s : s.code);
    if (!c) throw bad('Each section needs a code (A, B …).');
    if (out.some(x => x.code === c)) throw bad(`Section ${c} is listed twice.`);
    out.push({ code: c, isActive: typeof s === 'string' ? true : s.isActive !== false });
  }
  return out;
};

// POST /api/academics/cohorts  { programme, branch, admissionYear, name?, sections[] }
router.post('/cohorts', superadminOnly, async (req, res) => {
  try {
    const b = req.body;
    const prog = oid(b.programme) && await Programme.findById(b.programme).lean();
    if (!prog) throw bad('Programme not found');
    const branch = code(b.branch);
    if (branch && !prog.branches.some(x => x.code === branch)) throw bad(`Branch ${branch} is not part of ${prog.name}.`);
    const year = Number(b.admissionYear);
    if (!Number.isInteger(year)) throw bad('admissionYear must be a year, e.g. 2025');
    const name = String(b.name || '').trim() || `${prog.name}${branch ? ' ' + branch : ''} ${year}–${String(Math.round(year + (prog.durationYears || 4))).slice(-2)}`;
    const c = await Cohort.create({ programme: prog._id, branch, admissionYear: year, name, sections: sectionsIn(b.sections || []), createdBy: req.user._id });
    res.status(201).json({ cohort: c });
  } catch (err) { fail(res, err); }
});

// PATCH /api/academics/cohorts/:id  { name, sections[], isActive } — programme / branch / year stay
router.patch('/cohorts/:id', superadminOnly, async (req, res) => {
  try {
    if (!oid(req.params.id)) throw bad('Bad id');
    const c = await Cohort.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'Cohort not found' });
    if (req.body.name !== undefined) c.name = String(req.body.name).trim() || c.name;
    if (req.body.isActive !== undefined) c.isActive = !!req.body.isActive;
    if (req.body.sections !== undefined) {
      const next = sectionsIn(req.body.sections);
      const used = await Person.distinct('academic.section', { 'academic.cohort': c._id });
      const gone = used.filter(s => s && !next.some(x => x.code === s));
      if (gone.length) throw bad(`Students are in section ${gone.join(', ')} — switch it off (isActive false) instead of removing it.`);
      c.sections = next;
    }
    await c.save();
    res.json({ cohort: c });
  } catch (err) { fail(res, err); }
});

module.exports = router;
