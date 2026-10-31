// ─────────────────────────────────────────────────────────────────────
//  /api/placement — the placement officer's side (module "placement").
//  Admin and placement officers change; management (viewer) reads.
//
//  Drives: draft → published (students see it, share link works) → closed.
//  Applicants come with what they had when they applied (snapshot) and with
//  today's eligibility / verification, so the officer checks only the ones
//  shortlisted. Downloads: the list (Excel CSV) and all resumes (zip).
// ─────────────────────────────────────────────────────────────────────
const express  = require('express');
const mongoose = require('mongoose');
const crypto   = require('crypto');
const Company  = require('../models/Company');
const Drive    = require('../models/Drive');
const Application = require('../models/Application');
const Person   = require('../models/Person');
const Programme = require('../models/Programme');
const Cohort   = require('../models/Cohort');
const ProfileField = require('../models/ProfileField');
const Document = require('../models/Document');
const { protect, placementStaff } = require('../middleware/auth');
const elig     = require('../services/eligibility');
const docs     = require('../services/documents');
const people   = require('../services/people');
const { csv, zip } = require('../services/exporter');
const router   = express.Router();

const oid = (v) => mongoose.isValidObjectId(v);
const writers = (req, res, next) => ['superadmin', 'placement'].includes(req.user.role) ? next() : res.status(403).json({ message: 'Read-only account' });
class Bad extends Error {}
const fail = (res, err) => res.status(err instanceof Bad || err instanceof docs.DocError || err.name === 'ValidationError' || err.code === 11000 ? 400 : 500)
  .json({ message: err.code === 11000 ? 'That already exists.' : err.message });
const MODES = ['onCampus', 'virtual', 'offCampus', 'pool'];

router.use(protect, placementStaff);

// ── setup: what the drive editor needs ───────────────────────────────

// GET /api/placement/setup — fields rules can use, programmes + branches, passing years, companies
router.get('/setup', async (req, res) => {
  try {
    const [ctx, programmes, cohorts, companies] = await Promise.all([
      elig.context(), Programme.find({ isActive: true }).select('name code branches durationYears').sort('name').lean(),
      Cohort.find({}).select('programme admissionYear').lean(), Company.find({}).select('name').sort('name').lean(),
    ]);
    const dur = new Map(programmes.map(p => [String(p._id), p.durationYears || 4]));
    const years = [...new Set(cohorts.map(c => Math.round(c.admissionYear + (dur.get(String(c.programme)) || 4))))].sort();
    res.json({ ruleFields: elig.ruleFields(ctx), programmes: programmes.map(p => ({ _id: p._id, name: p.name, branches: (p.branches || []).filter(b => b.isActive !== false) })),
      passingYears: years, companies, standardFieldsMissing: elig.STANDARD.filter(f => !ctx.field.has(f.key)).map(f => f.label) });
  } catch (err) { fail(res, err); }
});

// POST /api/placement/setup/standard-fields — 10th %, 12th %, CGPA, backlogs, marksheets (once)
router.post('/setup/standard-fields', writers, async (req, res) => {
  try { res.json(await elig.ensureStandardFields(req.user._id)); } catch (err) { fail(res, err); }
});

// ── companies ────────────────────────────────────────────────────────

const companyInput = (b) => {
  const out = {};
  for (const k of ['name', 'website', 'industry', 'about']) if (b[k] !== undefined) out[k] = String(b[k] || '').trim();
  if (b.contacts !== undefined) out.contacts = (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 10)
    .map(c => ({ name: String(c.name || '').trim(), email: String(c.email || '').trim(), phone: String(c.phone || '').trim(), role: String(c.role || '').trim() }))
    .filter(c => c.name || c.email || c.phone);
  return out;
};
router.get('/companies', async (req, res) => {
  try {
    const list = await Company.find({}).sort('name').lean();
    const n = await Drive.aggregate([{ $group: { _id: '$company', drives: { $sum: 1 } } }]);
    const by = new Map(n.map(x => [String(x._id), x.drives]));
    res.json({ companies: list.map(c => ({ ...c, drives: by.get(String(c._id)) || 0 })) });
  } catch (err) { fail(res, err); }
});
router.post('/companies', writers, async (req, res) => {
  try {
    const b = companyInput(req.body || {});
    if (!b.name) throw new Bad('Company name is needed.');
    const same = await Company.findOne({ name: new RegExp(`^${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
    if (same) throw new Bad(`${same.name} is already in the list.`);
    res.status(201).json({ company: await Company.create({ ...b, createdBy: req.user._id }) });
  } catch (err) { fail(res, err); }
});
router.patch('/companies/:id', writers, async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const c = await Company.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'Company not found' });
    c.set(companyInput(req.body || {})); await c.save();
    res.json({ company: c });
  } catch (err) { fail(res, err); }
});

// ── drives ───────────────────────────────────────────────────────────

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
async function newSlug(company, title) {
  const base = slugify(`${company} ${title}`) || 'drive';
  for (let i = 0; i < 5; i++) {
    const s = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    if (!(await Drive.exists({ slug: s }))) return s;
  }
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

// body → drive fields, checked
async function driveInput(b, ctx) {
  const out = {};
  if (b.company !== undefined) {
    if (!oid(b.company) || !(await Company.exists({ _id: b.company }))) throw new Bad('Pick the company (or add it first).');
    out.company = b.company;
  }
  for (const k of ['title', 'description', 'location', 'bond', 'schedule']) if (b[k] !== undefined) out[k] = String(b[k] || '').trim();
  if (b.ctc !== undefined) {
    const n = (v) => v === '' || v === null || v === undefined ? null : Number(v);
    const min = n(b.ctc.min), max = n(b.ctc.max);
    if ([min, max].some(v => v !== null && !(v >= 0 && v < 1000))) throw new Bad('Package (LPA) must be a number.');
    if (min !== null && max !== null && max < min) throw new Bad('Highest package is less than the lowest.');
    out.ctc = { text: String(b.ctc.text || '').trim(), min, max };
  }
  if (b.mode !== undefined) { if (!MODES.includes(b.mode)) throw new Bad('Unknown drive mode.'); out.mode = b.mode; }
  if (b.applyBy !== undefined) {
    const d = new Date(b.applyBy);
    if (isNaN(d)) throw new Bad('Last date to apply is not a date.');
    out.applyBy = d;
  }
  if (b.audience !== undefined) {
    const a = b.audience || {};
    out.audience = {
      programmes: (a.programmes || []).filter(oid),
      branches: [...new Set((a.branches || []).map(x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))],
      passingYears: [...new Set((a.passingYears || []).map(Number).filter(Number.isInteger))],
    };
  }
  if (b.rules !== undefined) {
    if (!Array.isArray(b.rules) || b.rules.length > 15) throw new Bad('Rules must be a list (at most 15).');
    const rules = b.rules.map(r => ({ field: String(r.field || ''), op: r.op, value: typeof r.value === 'string' && r.value.trim() !== '' ? Number(r.value) : r.value }));
    for (const r of rules) { const e = elig.badRule(r, ctx); if (e) throw new Bad(e); }
    out.rules = rules;
  }
  if (b.questions !== undefined) {
    if (!Array.isArray(b.questions) || b.questions.length > 10) throw new Bad('At most 10 questions.');
    out.questions = b.questions.map((q, i) => {
      const label = String(q.label || '').trim();
      if (!label) throw new Bad('Each question needs its text.');
      const type = ['text', 'number', 'select', 'boolean', 'url'].includes(q.type) ? q.type : 'text';
      const options = [...new Set((q.options || []).map(o => String(o).trim()).filter(Boolean))].slice(0, 20);
      if (type === 'select' && options.length < 2) throw new Bad(`"${label}": give at least two choices.`);
      return { key: /^[a-z][a-z0-9_]{0,29}$/.test(q.key || '') ? q.key : null, label, type, options, required: !!q.required };
    });
    // new questions get the next free key (q1, q2 …), so answers already given keep theirs
    const used = new Set(out.questions.map(q => q.key).filter(Boolean));
    for (const q of out.questions) if (!q.key) { let n = 1; while (used.has(`q${n}`)) n++; q.key = `q${n}`; used.add(q.key); }
    if (new Set(out.questions.map(q => q.key)).size !== out.questions.length) throw new Bad('Two questions have the same key.');
  }
  for (const k of ['verifiedOnly', 'resumeRequired', 'publicPreview']) if (b[k] !== undefined) out[k] = !!b[k];
  return out;
}

// counts for the preview: visible / eligible / incomplete / not eligible / needs verification
async function counts(drive, ctx) {
  const list = await Person.find({ status: 'studying', demo: { $ne: true } }).select('academic custom verified status demo').lean();
  const out = { visible: 0, eligible: 0, incomplete: 0, notEligible: 0, needsVerification: 0 };
  for (const p of list) {
    const r = elig.check(drive, p, ctx);
    if (r.state === 'hidden') continue;
    out.visible++; out[r.state]++;
  }
  return out;
}

const driveView = (d, extra = {}) => ({
  _id: d._id, slug: d.slug, status: d.status, title: d.title, company: d.company?.name ? { _id: d.company._id, name: d.company.name } : d.company,
  ctc: d.ctc, location: d.location, mode: d.mode, applyBy: d.applyBy, publishedAt: d.publishedAt, opens: d.opens || 0, ...extra,
});

// GET /api/placement/drives?status=
router.get('/drives', async (req, res) => {
  try {
    const f = ['draft', 'published', 'closed'].includes(req.query.status) ? { status: req.query.status } : {};
    const list = await Drive.find(f).populate('company', 'name').sort('-createdAt').lean();
    const n = await Application.aggregate([{ $match: { status: 'applied' } }, { $group: { _id: '$drive', n: { $sum: 1 } } }]);
    const by = new Map(n.map(x => [String(x._id), x.n]));
    res.json({ drives: list.map(d => driveView(d, { applied: by.get(String(d._id)) || 0 })) });
  } catch (err) { fail(res, err); }
});

// POST /api/placement/drives/check { audience, rules, verifiedOnly } — counts before saving
router.post('/drives/check', async (req, res) => {
  try {
    const ctx = await elig.context();
    const d = await driveInput({ audience: req.body?.audience, rules: req.body?.rules || [], verifiedOnly: req.body?.verifiedOnly }, ctx);
    res.json({ counts: await counts(d, ctx) });
  } catch (err) { fail(res, err); }
});

// POST /api/placement/drives — a new draft
router.post('/drives', writers, async (req, res) => {
  try {
    const ctx = await elig.context();
    const b = await driveInput(req.body || {}, ctx);
    if (!b.company) throw new Bad('Pick the company.');
    if (!b.title) throw new Bad('Give the role (e.g. "Graduate Engineer Trainee").');
    if (!b.applyBy) throw new Bad('Give the last date to apply.');
    const company = await Company.findById(b.company).select('name').lean();
    const d = await Drive.create({ ...b, slug: await newSlug(company.name, b.title), status: 'draft', createdBy: req.user._id });
    res.status(201).json({ drive: d });
  } catch (err) { fail(res, err); }
});

// GET /api/placement/drives/:id — the drive, its counts, share text
router.get('/drives/:id', async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const d = await Drive.findById(req.params.id).populate('company').populate('jd', 'name contentType size').lean();
    if (!d) return res.status(404).json({ message: 'Drive not found' });
    const ctx = await elig.context();
    const [c, applied, withdrawn] = await Promise.all([counts(d, ctx), Application.countDocuments({ drive: d._id, status: 'applied' }), Application.countDocuments({ drive: d._id, status: 'withdrawn' })]);
    res.json({ drive: d, counts: { ...c, applied, withdrawn } });
  } catch (err) { fail(res, err); }
});

// PATCH /api/placement/drives/:id
router.patch('/drives/:id', writers, async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const d = await Drive.findById(req.params.id);
    if (!d) return res.status(404).json({ message: 'Drive not found' });
    const ctx = await elig.context();
    d.set(await driveInput(req.body || {}, ctx)); d.updatedBy = req.user._id;
    await d.save();
    res.json({ drive: d });
  } catch (err) { fail(res, err); }
});

// POST /api/placement/drives/:id/status { status: published | closed | draft }
router.post('/drives/:id/status', writers, async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const d = await Drive.findById(req.params.id);
    if (!d) return res.status(404).json({ message: 'Drive not found' });
    const to = req.body?.status;
    if (!['published', 'closed', 'draft'].includes(to)) throw new Bad('status must be published, closed or draft');
    if (to === 'draft' && await Application.exists({ drive: d._id })) throw new Bad('Students have applied — close the drive instead of making it a draft.');
    if (to === 'published') {
      if (!d.title || !d.company || !d.applyBy) throw new Bad('Fill in the company, role and last date first.');
      if (d.status !== 'published') d.publishedAt = d.publishedAt || new Date();
    }
    d.status = to; d.updatedBy = req.user._id; await d.save();
    res.json({ drive: d });
  } catch (err) { fail(res, err); }
});

// POST /api/placement/drives/:id/jd { data: dataUrl, name } — the JD file (PDF / image)
router.post('/drives/:id/jd', writers, async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const d = await Drive.findById(req.params.id);
    if (!d) return res.status(404).json({ message: 'Drive not found' });
    const doc = await docs.save({ dataUrl: req.body?.data, name: req.body?.name || 'JD', kind: 'jd', uploadedBy: req.user._id });
    d.jd = doc._id; await d.save();
    res.json({ jd: docs.view(doc) });
  } catch (err) { fail(res, err); }
});

// ── applicants ───────────────────────────────────────────────────────

async function applicants(drive) {
  const [apps, ctx] = await Promise.all([
    Application.find({ drive: drive._id }).populate('resume', 'name contentType size').sort('appliedAt').lean(),
    elig.context(),
  ]);
  const ppl = await Person.find({ _id: { $in: apps.map(a => a.person) } }).select('name roll academic custom verified status demo contact links').setOptions({ allOrgs: false }).lean();
  const by = new Map(ppl.map(p => [String(p._id), p]));
  return apps.map(a => {
    const p = by.get(String(a.person));
    const now = p ? elig.check(drive, p, ctx) : null;
    const needs = (drive.rules || []).map(r => r.field).filter(k => ctx.field.get(k)?.needsVerification);
    return { _id: a._id, status: a.status, appliedAt: a.appliedAt, withdrawnAt: a.withdrawnAt, answers: a.answers, resume: docs.view(a.resume),
      snapshot: a.snapshot, person: p ? { _id: p._id, name: p.name, roll: p.roll } : null,
      now: now && { state: now.state, reasons: now.reasons, unverified: needs.filter(k => !p.verified?.[k]) } };
  });
}

// GET /api/placement/drives/:id/applicants?status=applied|withdrawn|all
router.get('/drives/:id/applicants', async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const d = await Drive.findById(req.params.id).lean();
    if (!d) return res.status(404).json({ message: 'Drive not found' });
    let list = await applicants(d);
    const st = req.query.status || 'applied';
    if (st !== 'all') list = list.filter(a => a.status === st);
    const ctx = await elig.context();
    res.json({ applicants: list, fields: (d.rules || []).map(r => r.field).filter((k, i, a) => a.indexOf(k) === i).map(k => ({ key: k, label: ctx.field.get(k)?.label || k })),
      questions: d.questions });
  } catch (err) { fail(res, err); }
});

// GET /api/placement/drives/:id/export.csv — the list for the company (opens in Excel)
router.get('/drives/:id/export.csv', async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const d = await Drive.findById(req.params.id).populate('company', 'name').lean();
    if (!d) return res.status(404).json({ message: 'Drive not found' });
    const ctx = await elig.context();
    const list = (await applicants(d)).filter(a => a.status === 'applied');
    const numberFields = [...ctx.field.values()].filter(f => f.isActive !== false && f.editableBy === 'student' && f.type !== 'file');
    const head = ['#', 'Name', 'Roll', 'Programme', 'Branch', 'Section', 'Passing year', 'Mobile', 'Email', 'GitHub', 'LinkedIn',
      ...numberFields.map(f => f.label), 'Not yet verified', ...d.questions.map(q => q.label), 'Resume file', 'Applied on'];
    const rows = list.map((a, i) => {
      const s = a.snapshot || {};
      return [i + 1, s.name, s.roll, s.programme, s.branch, s.section, s.passingYear, s.phone, s.email, s.github, s.linkedin,
        ...numberFields.map(f => s.fields?.[f.key] ?? ''), (a.now?.unverified || []).map(k => ctx.field.get(k)?.label || k),
        ...d.questions.map(q => a.answers?.[q.key] ?? ''), a.resume ? resumeName(a, i) : '', new Date(a.appliedAt).toISOString().slice(0, 10)];
    });
    res.set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${slugify(d.company?.name)}-${slugify(d.title)}-applicants.csv"`)
      .send(csv([head, ...rows]));
  } catch (err) { fail(res, err); }
});
const resumeName = (a, i) => `${String(i + 1).padStart(3, '0')} ${a.snapshot?.name || 'student'} ${a.snapshot?.roll || ''}`.trim() + (a.resume?.contentType === 'application/pdf' ? '.pdf' : a.resume?.contentType === 'image/png' ? '.png' : '.jpg');

// GET /api/placement/drives/:id/resumes.zip — every applicant's resume, named like the list
router.get('/drives/:id/resumes.zip', async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const d = await Drive.findById(req.params.id).populate('company', 'name').lean();
    if (!d) return res.status(404).json({ message: 'Drive not found' });
    const list = (await applicants(d)).filter(a => a.status === 'applied');
    const files = [];
    for (const [i, a] of list.entries()) {
      if (!a.resume) continue;
      const doc = await Document.findById(a.resume.id).select('+data').lean();
      const buf = doc && await docs.bytes(doc);
      if (buf) files.push({ name: resumeName(a, i), data: buf });
    }
    if (!files.length) return res.status(404).json({ message: 'No resumes yet.' });
    res.set('Content-Type', 'application/zip')
      .set('Content-Disposition', `attachment; filename="${slugify(d.company?.name)}-${slugify(d.title)}-resumes.zip"`)
      .send(zip(files));
  } catch (err) { fail(res, err); }
});

// GET /api/placement/documents/:id — a student's resume / marksheet, a JD
router.get('/documents/:id', async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const doc = await Document.findById(req.params.id).select('+data').lean();
    if (!doc) return res.status(404).json({ message: 'File not found' });
    const buf = await docs.bytes(doc);
    res.set('Content-Type', doc.contentType).set('Content-Disposition', `inline; filename="${doc.name.replace(/"/g, '')}"`)
      .set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').send(buf);
  } catch (err) { fail(res, err); }
});

// ── verifying and importing marks ────────────────────────────────────

// POST /api/placement/verify { personId, keys: ['cgpa', …], verified: true|false }
router.post('/verify', writers, async (req, res) => {
  try {
    const { personId, keys, verified = true } = req.body || {};
    if (!oid(personId)) throw new Bad('Which student?');
    const p = await Person.findById(personId);
    if (!p) return res.status(404).json({ message: 'Student not found' });
    const fields = await ProfileField.find({ key: { $in: keys || [] } }).lean();
    if (!fields.length) throw new Bad('Which values?');
    const ver = { ...(p.verified || {}) };
    for (const f of fields) {
      if (verified) {
        if (p.custom?.[f.key] === undefined || p.custom?.[f.key] === null || p.custom?.[f.key] === '') throw new Bad(`${p.name} has not filled ${f.label}.`);
        ver[f.key] = { at: new Date(), by: req.user._id };
      } else delete ver[f.key];
    }
    p.verified = ver; p.markModified('verified'); p.updatedBy = req.user._id;
    await p.save();
    res.json({ ok: true, verified: Object.keys(ver).filter(k => ver[k]) });
  } catch (err) { fail(res, err); }
});

// POST /api/placement/import { rows: [{ roll, cgpa: 7.2, tenth_percent: 81, … }], apply: false|true }
// Marks from the college's own records: saved as VERIFIED. Preview first (apply=false).
router.post('/import', writers, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) throw new Bad('Paste the rows first.');
    if (rows.length > 3000) throw new Bad('At most 3000 rows at a time.');
    const fields = (await ProfileField.find({ isActive: true }).lean()).filter(f => f.type !== 'file');
    const byKey = new Map(fields.map(f => [f.key, f]));
    const cols = [...new Set(rows.flatMap(r => Object.keys(r)).filter(k => k !== 'roll'))];
    const unknown = cols.filter(k => !byKey.has(k));
    if (unknown.length) throw new Bad(`Unknown column(s): ${unknown.join(', ')}. Use: roll, ${[...byKey.keys()].join(', ')}.`);
    const rx = (r) => new RegExp(`^\\s*${String(r).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    const out = { matched: 0, notFound: [], problems: [], changes: 0 };
    const ops = [];
    for (const [i, r] of rows.entries()) {
      const roll = String(r.roll || '').trim();
      if (!roll) { out.problems.push(`Row ${i + 1}: no roll`); continue; }
      const p = await Person.findOne({ roll: rx(roll) }).select('roll custom verified').lean();
      if (!p) { out.notFound.push(roll); continue; }
      const input = Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'roll' && v !== '' && v !== null && v !== undefined));
      const { values, errors } = people.checkCustom(fields, input);
      if (errors.length) { out.problems.push(`${roll}: ${errors.join(' ')}`); continue; }
      out.matched++;
      const set = {};
      for (const [k, v] of Object.entries(values)) { set[`custom.${k}`] = v; set[`verified.${k}`] = { at: new Date(), by: req.user._id }; out.changes++; }
      if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: set } } });
    }
    if (req.body?.apply === true && ops.length) await Person.bulkWrite(ops);
    res.json({ applied: req.body?.apply === true, columns: cols, ...out });
  } catch (err) { fail(res, err); }
});

module.exports = router;
