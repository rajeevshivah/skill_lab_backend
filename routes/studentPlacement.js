// ─────────────────────────────────────────────────────────────────────
//  /api/student/placement — what a STUDENT does in placement (module on).
//  Drives they can see (audience), with whether they can apply and why not;
//  apply / withdraw; their files (resume, marksheets).
//
//  Also /api/placement-public/:slug (no sign-in): the little card a shared
//  link shows before sign-in — company, role, last date — when the drive
//  allows it.
// ─────────────────────────────────────────────────────────────────────
const express  = require('express');
const mongoose = require('mongoose');
const Drive    = require('../models/Drive');
const Application = require('../models/Application');
const Document = require('../models/Document');
const Person   = require('../models/Person');
const Organization = require('../models/Organization');
const elig     = require('../services/eligibility');
const docs     = require('../services/documents');
const tenant   = require('../services/tenant');
const { protectStudent } = require('./student').__shared;
const router   = express.Router();

const oid = (v) => mongoose.isValidObjectId(v);
class Bad extends Error {}
const fail = (res, err) => res.status(err instanceof Bad || err instanceof docs.DocError ? 400 : 500).json({ message: err.message });

router.use(protectStudent);

const isOpen = (d) => d.status === 'published' && new Date(d.applyBy) >= new Date();
const card = (d, r, app) => ({
  slug: d.slug, title: d.title, company: d.company?.name || '', ctc: d.ctc?.text || '', location: d.location, mode: d.mode,
  applyBy: d.applyBy, publishedAt: d.publishedAt, open: isOpen(d), status: d.status,
  eligibility: { state: r.state, reasons: r.reasons, missing: r.missing, unverified: r.unverified },
  application: app ? { status: app.status, appliedAt: app.appliedAt } : null,
  isNew: !app && d.publishedAt && (Date.now() - new Date(d.publishedAt)) < 3 * 864e5,
});

// GET /api/student/placement/drives — open drives they can see, and every drive they applied to
router.get('/drives', async (req, res) => {
  try {
    const [ctx, mine] = await Promise.all([elig.context(), Application.find({ person: req.person._id }).lean()]);
    const appBy = new Map(mine.map(a => [String(a.drive), a]));
    const list = await Drive.find({ $or: [{ status: 'published' }, { _id: { $in: mine.map(a => a.drive) } }] })
      .populate('company', 'name').sort('applyBy').lean();
    const out = [];
    for (const d of list) {
      const app = appBy.get(String(d._id));
      const r = elig.check(d, req.person, ctx);
      if (r.state === 'hidden' && !app) continue;
      if (!isOpen(d) && !app) continue;              // a past drive they did not apply to: nothing to do
      out.push(card(d, r, app));
    }
    res.json({ drives: out, openForMe: out.filter(x => x.open && !x.application && x.eligibility.state === 'eligible').length });
  } catch (err) { fail(res, err); }
});

// GET /api/student/placement/drives/:slug  (?src=share counts an open of the shared link)
router.get('/drives/:slug', async (req, res) => {
  try {
    const d = await Drive.findOne({ slug: String(req.params.slug).toLowerCase(), status: { $ne: 'draft' } }).populate('company', 'name website about').populate('jd', 'name contentType size').lean();
    if (!d) return res.status(404).json({ message: 'This drive is not open.' });
    const [ctx, app] = await Promise.all([elig.context(), Application.findOne({ drive: d._id, person: req.person._id }).populate('resume', 'name contentType size createdAt').lean()]);
    const r = elig.check(d, req.person, ctx);
    if (req.query.src === 'share') await Drive.updateOne({ _id: d._id }, { $inc: { opens: 1 } });
    if (r.state === 'hidden' && !app)
      return res.json({ drive: { slug: d.slug, title: d.title, company: d.company?.name || '' }, hidden: true, message: 'This drive is not open for your batch.' });
    const resume = await Document.findOne({ owner: req.person._id, kind: 'resume' }).sort('-createdAt').lean();
    res.json({
      drive: { ...card(d, r, app), description: d.description, schedule: d.schedule, bond: d.bond, companyWebsite: d.company?.website || '',
        companyAbout: d.company?.about || '', jd: docs.view(d.jd), questions: d.questions, resumeRequired: d.resumeRequired, verifiedOnly: d.verifiedOnly,
        rules: (d.rules || []).map(x => ({ label: ctx.field.get(x.field)?.label || (x.field === 'semesterNo' ? 'Semester' : x.field), op: x.op, value: x.value })) },
      application: app ? { status: app.status, appliedAt: app.appliedAt, answers: app.answers, resume: docs.view(app.resume) } : null,
      myResume: docs.view(resume),
    });
  } catch (err) { fail(res, err); }
});

// What the company gets: the student as they were at the moment they applied.
function snapshot(p, ctx) {
  const prog = p.academic?.programme && ctx.prog.get(String(p.academic.programme));
  const fields = Object.fromEntries([...ctx.field.values()].filter(f => f.isActive !== false && f.type !== 'file' && p.custom?.[f.key] !== undefined)
    .map(f => [f.key, p.custom[f.key]]));
  return { name: p.name, roll: p.roll, programme: prog?.name || '', branch: p.academic?.branch || '', section: p.academic?.section || '',
    semesterNo: p.academic?.semesterNo ?? null, passingYear: elig.passingYear(p, ctx), phone: p.contact?.phone || '', email: p.contact?.email || '',
    github: p.links?.github || '', linkedin: p.links?.linkedin || '', portfolio: p.links?.portfolio || '', fields,
    verified: Object.keys(p.verified || {}).filter(k => p.verified[k]) };
}

function checkAnswers(questions, input) {
  const out = {};
  for (const q of questions) {
    let v = input?.[q.key];
    const empty = v === undefined || v === null || v === '';
    if (empty) { if (q.required) throw new Bad(`Answer: ${q.label}`); continue; }
    if (q.type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw new Bad(`${q.label}: give a number.`); }
    else if (q.type === 'boolean') { if (typeof v !== 'boolean') throw new Bad(`${q.label}: choose yes or no.`); }
    else if (q.type === 'select') { if (!q.options.includes(String(v))) throw new Bad(`${q.label}: pick one of the choices.`); v = String(v); }
    else if (q.type === 'url') { v = String(v).trim(); if (!/^https?:\/\/\S+$/i.test(v) || v.length > 300) throw new Bad(`${q.label}: give a link starting with https://`); }
    else v = String(v).slice(0, 1000);
    out[q.key] = v;
  }
  return out;
}

// POST /api/student/placement/drives/:slug/apply { answers: {}, resumeId, declaration: true }
router.post('/drives/:slug/apply', async (req, res) => {
  try {
    const d = await Drive.findOne({ slug: String(req.params.slug).toLowerCase() }).lean();
    if (!d || d.status === 'draft') return res.status(404).json({ message: 'This drive is not open.' });
    if (!isOpen(d)) throw new Bad('Applications for this drive are closed.');
    const ctx = await elig.context();
    const r = elig.check(d, req.person, ctx);
    if (r.state === 'hidden') throw new Bad('This drive is not open for your batch.');
    if (r.state === 'incomplete') throw new Bad(`Complete your profile first: ${r.missing.join(', ')}.`);
    if (r.state === 'notEligible') throw new Bad(`You are not eligible: ${r.reasons.join('; ')}.`);
    if (r.state === 'needsVerification') throw new Bad('This company takes verified details only. Ask your placement office to verify your marks.');
    if (req.body?.declaration !== true) throw new Bad('Tick that your details are correct.');
    const answers = checkAnswers(d.questions || [], req.body?.answers || {});
    let resume = null;
    if (req.body?.resumeId) {
      if (!oid(req.body.resumeId)) throw new Bad('Upload your resume again.');
      resume = await Document.findOne({ _id: req.body.resumeId, owner: req.person._id }).select('_id').lean();
      if (!resume) throw new Bad('Upload your resume again.');
    }
    if (d.resumeRequired && !resume) throw new Bad('Attach your resume.');
    const existing = await Application.findOne({ drive: d._id, person: req.person._id });
    if (existing?.status === 'applied') throw new Bad('You have already applied.');
    if (req.demo) return res.status(201).json({ ok: true, demo: true, message: 'Demo account — this was not saved.' });
    const set = { status: 'applied', answers, resume: resume?._id || null, snapshot: snapshot(req.person.toObject ? req.person.toObject() : req.person, ctx),
      unverified: r.unverified, declaredAt: new Date(), appliedAt: new Date(), withdrawnAt: null };
    if (existing) { existing.set(set); await existing.save(); }
    else await Application.create({ drive: d._id, person: req.person._id, ...set });
    res.status(201).json({ ok: true });
  } catch (err) { fail(res, err); }
});

// POST /api/student/placement/drives/:slug/withdraw — before the last date
router.post('/drives/:slug/withdraw', async (req, res) => {
  try {
    const d = await Drive.findOne({ slug: String(req.params.slug).toLowerCase() }).lean();
    if (!d) return res.status(404).json({ message: 'Drive not found' });
    if (!isOpen(d)) throw new Bad('Applications are closed — talk to your placement office.');
    const a = await Application.findOne({ drive: d._id, person: req.person._id, status: 'applied' });
    if (!a) throw new Bad('You have not applied.');
    if (req.demo) return res.json({ ok: true, demo: true });
    a.status = 'withdrawn'; a.withdrawnAt = new Date(); await a.save();
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// POST /api/student/placement/documents { kind: 'resume' | 'marksheet', name, data: dataUrl }
router.post('/documents', async (req, res) => {
  try {
    const kind = ['resume', 'marksheet'].includes(req.body?.kind) ? req.body.kind : 'other';
    if (req.demo) throw new Bad('Demo account — files are not saved.');
    const doc = await docs.save({ dataUrl: req.body?.data, name: req.body?.name, kind, owner: req.person._id });
    res.status(201).json({ document: docs.view(doc) });
  } catch (err) { fail(res, err); }
});

// GET /api/student/placement/documents/:id — their own file
router.get('/documents/:id', async (req, res) => {
  try {
    if (!oid(req.params.id)) throw new Bad('Bad id');
    const doc = await Document.findOne({ _id: req.params.id, $or: [{ owner: req.person._id }, { owner: null, kind: 'jd' }] }).select('+data').lean();
    if (!doc) return res.status(404).json({ message: 'File not found' });
    res.set('Content-Type', doc.contentType).set('Content-Disposition', `inline; filename="${doc.name.replace(/"/g, '')}"`)
      .set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').send(await docs.bytes(doc));
  } catch (err) { fail(res, err); }
});

// ── public card for a shared link (no sign-in) ───────────────────────
const pub = express.Router();
// GET /api/placement-public/:slug
pub.get('/:slug', async (req, res) => {
  try {
    if (!req.org) return res.status(404).json({ message: 'Not found' });
    if (!Organization.modulesOf(req.org.modules).placement) return res.status(404).json({ message: 'Not found' });
    const d = await Drive.findOne({ slug: String(req.params.slug).toLowerCase(), status: 'published' }).populate('company', 'name').lean();
    if (!d) return res.status(404).json({ message: 'This drive is not open.' });
    res.set('Cache-Control', 'no-store');
    if (!d.publicPreview) return res.json({ drive: { slug: d.slug, open: isOpen(d) }, college: req.org.shortName || req.org.name });
    res.json({ drive: { slug: d.slug, title: d.title, company: d.company?.name || '', applyBy: d.applyBy, location: d.location, open: isOpen(d) }, college: req.org.shortName || req.org.name });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
module.exports.publicRouter = pub;
