// ─────────────────────────────────────────────────────────────────────
//  /api/people — the college's students as PEOPLE (one per real student),
//  shared by every module. Admin changes; management (viewer) reads.
//
//  Name and roll are still changed on the training record (Students page /
//  edit_student) while the move-over runs; "link" copies them here.
// ─────────────────────────────────────────────────────────────────────
const express   = require('express');
const mongoose  = require('mongoose');
const Person    = require('../models/Person');
const Student   = require('../models/Student');
const Programme = require('../models/Programme');
const Cohort    = require('../models/Cohort');
const ProfileField = require('../models/ProfileField');
const { protect, superadminOnly } = require('../middleware/auth');
const people    = require('../services/people');
const router    = express.Router();

const readers = (req, res, next) => ['superadmin', 'viewer', 'placement'].includes(req.user.role) ? next() : res.status(403).json({ message: 'Admin, placement or management only' });
// admin, or the placement officer (marks, verification, placement fields)
const editors = (req, res, next) => ['superadmin', 'placement'].includes(req.user.role) ? next() : res.status(403).json({ message: 'Admin or placement officer only' });
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const oid = (v) => mongoose.isValidObjectId(v);
const fail = (res, err) => res.status(err instanceof people.LinkError || err.name === 'ValidationError' || err.code === 11000 ? 400 : 500)
  .json({ message: err.code === 11000 ? 'That already exists.' : err.message });

router.use(protect);

// ── profile fields (before /:id) ─────────────────────────────────────

// GET /api/people/fields
router.get('/fields', readers, async (req, res) => {
  try { res.json({ fields: await ProfileField.find({}).sort('group order label').lean(), types: ProfileField.TYPES }); }
  catch (err) { fail(res, err); }
});

const fieldInput = (b) => {
  const out = {};
  for (const k of ['label', 'type', 'group', 'help', 'required', 'min', 'max', 'editableBy', 'needsVerification', 'order', 'isActive']) if (b[k] !== undefined) out[k] = b[k];
  if (b.options !== undefined) out.options = [...new Set((b.options || []).map(o => String(o).trim()).filter(Boolean))].slice(0, 50);
  return out;
};
const optionsOk = (f) => !['select', 'multiselect'].includes(f.type) || f.options.length > 0;

// POST /api/people/fields  { key, label, type, options[], group, editableBy, needsVerification, … }
router.post('/fields', editors, async (req, res) => {
  try {
    const f = new ProfileField({ key: req.body.key, ...fieldInput(req.body), createdBy: req.user._id });
    if (!optionsOk(f)) return res.status(400).json({ message: 'A choice field needs its options.' });
    await f.save();
    res.status(201).json({ field: f });
  } catch (err) { fail(res, err); }
});

// PATCH /api/people/fields/:id — the key and type stay (saved values depend on them)
router.patch('/fields/:id', editors, async (req, res) => {
  try {
    if (!oid(req.params.id)) return res.status(400).json({ message: 'Bad id' });
    const f = await ProfileField.findById(req.params.id);
    if (!f) return res.status(404).json({ message: 'Field not found' });
    const { type, ...rest } = fieldInput(req.body);
    if (type && type !== f.type) return res.status(400).json({ message: 'The type of a field cannot change once made — add a new field instead.' });
    f.set(rest);
    if (!optionsOk(f)) return res.status(400).json({ message: 'A choice field needs its options.' });
    await f.save();
    res.json({ field: f });
  } catch (err) { fail(res, err); }
});

// ── linking training records → people ────────────────────────────────

// POST /api/people/link  { apply: false|true, merge: [[studentId…]] }
router.post('/link', superadminOnly, async (req, res) => {
  try {
    const merge = Array.isArray(req.body.merge) ? req.body.merge.filter(Array.isArray).slice(0, 100) : [];
    res.json(await people.link({ apply: req.body.apply === true, merge, userId: req.user._id }));
  } catch (err) { fail(res, err); }
});

// ── people ───────────────────────────────────────────────────────────

const view = (p) => ({
  _id: p._id, name: p.name, roll: p.roll, rollTemporary: !!p.rollTemporary, status: p.status,
  programme: p.academic?.programme ? { _id: p.academic.programme._id, name: p.academic.programme.name } : null,
  cohort: p.academic?.cohort ? { _id: p.academic.cohort._id, name: p.academic.cohort.name } : null,
  branch: p.academic?.branch || '', section: p.academic?.section || '', semesterNo: p.academic?.semesterNo ?? null,
});

// GET /api/people?q=&programme=&cohort=&section=&status=&unlinked=1&page=1
router.get('/', readers, async (req, res) => {
  try {
    const f = { demo: { $ne: true } };
    if (req.query.q) f.$or = [{ name: rx(req.query.q) }, { roll: rx(req.query.q) }];
    if (oid(req.query.programme)) f['academic.programme'] = req.query.programme;
    if (oid(req.query.cohort)) f['academic.cohort'] = req.query.cohort;
    if (req.query.section) f['academic.section'] = String(req.query.section).toUpperCase();
    if (Person.STATUS.includes(req.query.status)) f.status = req.query.status;
    const page = Math.max(1, parseInt(req.query.page) || 1), size = 50;
    const [total, rows] = await Promise.all([
      Person.countDocuments(f),
      Person.find(f).sort('name').skip((page - 1) * size).limit(size)
        .populate('academic.programme', 'name').populate('academic.cohort', 'name').lean(),
    ]);
    const places = await Student.find({ person: { $in: rows.map(r => r._id) } }).select('person batch').populate('batch', 'name isActive').setOptions({ withDemo: true }).lean();
    const byPerson = new Map();
    for (const s of places) (byPerson.get(String(s.person)) || byPerson.set(String(s.person), []).get(String(s.person))).push(s.batch?.name || '?');
    const unlinked = await Student.countDocuments({ person: null });
    res.json({ total, page, pageSize: size, unlinkedTrainingRecords: unlinked,
      people: rows.map(p => ({ ...view(p), batches: byPerson.get(String(p._id)) || [] })) });
  } catch (err) { fail(res, err); }
});

// GET /api/people/:id — the person, their training places, and the college's profile fields
router.get('/:id', readers, async (req, res) => {
  try {
    if (!oid(req.params.id)) return res.status(400).json({ message: 'Bad id' });
    const p = await Person.findById(req.params.id).populate('academic.programme', 'name code').populate('academic.cohort', 'name admissionYear').lean();
    if (!p) return res.status(404).json({ message: 'Person not found' });
    const [places, fields] = await Promise.all([
      Student.find({ person: p._id }).select('batch semester roll stats flagged photo.contentType').populate('batch', 'name track isActive').populate('semester', 'name status').setOptions({ withDemo: true }).lean(),
      ProfileField.find({ isActive: true }).sort('group order label').lean(),
    ]);
    const prof = require('../services/profile');
    const hasPhoto = !!p.photo?.contentType || places.some(x => x.photo?.contentType);
    res.json({
      person: { ...view(p), ids: p.ids, entry: p.academic?.entry, contact: { email: p.contact?.email || '', phone: p.contact?.phone || '',
          emailVerified: !!p.contact?.emailVerifiedAt, phoneVerified: !!p.contact?.phoneVerifiedAt },
        links: p.links, custom: p.custom || {}, source: p.source, createdAt: p.createdAt, updatedAt: p.updatedAt,
        signIn: { setUp: !!p.login?.activatedAt, lastSignedIn: p.login?.lastLoginAt || null },
        profileConsentAt: p.consents?.profileAt || null,
        profileComplete: prof.completion(p, fields.filter(f => f.editableBy === 'student'), hasPhoto) },
      places: places.map(s => ({ studentId: s._id, batch: s.batch?.name, track: s.batch?.track, batchActive: s.batch?.isActive !== false,
        semester: s.semester?.name, semesterActive: s.semester?.status === 'active', flagged: !!s.flagged,
        attendance: s.stats?.totalSessions ? Math.round(100 * s.stats.presentCount / s.stats.totalSessions) : null })),
      fields,
    });
  } catch (err) { fail(res, err); }
});

// PATCH /api/people/:id  { programme, branch, cohort, section, semesterNo, entry, status, contact{}, links{}, ids[], custom{} }
router.patch('/:id', editors, async (req, res) => {
  try {
    if (!oid(req.params.id)) return res.status(400).json({ message: 'Bad id' });
    const p = await Person.findById(req.params.id);
    if (!p) return res.status(404).json({ message: 'Person not found' });
    const b = req.body || {};
    if (b.name !== undefined || b.roll !== undefined)
      return res.status(400).json({ message: 'Change the name or roll on the student\'s batch record for now (it is copied here).' });

    // where they are: programme → branch → cohort → section must agree
    const programmeId = b.programme !== undefined ? b.programme : p.academic.programme;
    let prog = null;
    if (programmeId) {
      if (!oid(programmeId) || !(prog = await Programme.findById(programmeId).lean())) return res.status(400).json({ message: 'Programme not found' });
    }
    if (b.programme !== undefined) p.academic.programme = prog?._id || null;
    if (b.branch !== undefined) {
      const code = String(b.branch || '').toUpperCase();
      if (code && !prog?.branches?.some(x => x.code === code)) return res.status(400).json({ message: `Branch ${code} is not part of ${prog?.name || 'the programme'}.` });
      p.academic.branch = code;
    }
    if (b.cohort !== undefined) {
      if (b.cohort) {
        const c = oid(b.cohort) && await Cohort.findById(b.cohort).lean();
        if (!c) return res.status(400).json({ message: 'Cohort not found' });
        if (!prog || String(c.programme) !== String(prog._id)) return res.status(400).json({ message: 'That cohort belongs to another programme.' });
        p.academic.cohort = c._id;
      } else p.academic.cohort = null;
    }
    if (b.section !== undefined) {
      const code = String(b.section || '').toUpperCase();
      const c = p.academic.cohort && await Cohort.findById(p.academic.cohort).lean();
      if (code && !c?.sections?.some(s => s.code === code)) return res.status(400).json({ message: `Section ${code} is not a section of the cohort — add it to the cohort first.` });
      p.academic.section = code;
    }
    if (b.semesterNo !== undefined) p.academic.semesterNo = b.semesterNo === null ? null : Number(b.semesterNo);
    if (b.entry !== undefined) p.academic.entry = b.entry;
    if (b.status !== undefined) p.status = b.status;
    for (const k of ['email', 'phone']) if (b.contact?.[k] !== undefined) p.contact[k] = b.contact[k];
    for (const k of ['github', 'linkedin', 'portfolio']) if (b.links?.[k] !== undefined) {
      const v = String(b.links[k] || '').trim();
      if (v && !/^https?:\/\/\S+$/i.test(v)) return res.status(400).json({ message: `${k} must be a web link (https://…).` });
      p.links[k] = v;
    }
    if (b.contact?.email && !/^\S+@\S+\.\S+$/.test(String(b.contact.email))) return res.status(400).json({ message: 'That email does not look right.' });
    if (b.ids !== undefined) {
      if (!Array.isArray(b.ids) || b.ids.length > 10) return res.status(400).json({ message: 'ids must be a list (at most 10).' });
      p.ids = b.ids.map(x => ({ type: x.type, value: String(x.value || '').trim() })).filter(x => x.value);
    }
    if (b.custom !== undefined) {
      const fields = await ProfileField.find({}).lean();
      const { values, errors } = people.checkCustom(fields, b.custom);
      if (errors.length) return res.status(400).json({ message: errors.join(' ') });
      const next = { ...(p.custom || {}) }, ver = { ...(p.verified || {}) };
      for (const [k, v] of Object.entries(values)) {
        if (v === null) { delete next[k]; delete ver[k]; }
        else { next[k] = v; ver[k] = { at: new Date(), by: req.user._id }; }   // typed in by staff = checked
      }
      p.custom = next; p.markModified('custom');
      p.verified = ver; p.markModified('verified');
    }
    p.updatedBy = req.user._id;
    await p.save();
    res.json({ person: p });
  } catch (err) { fail(res, err); }
});

module.exports = router;
