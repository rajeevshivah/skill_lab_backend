// ─────────────────────────────────────────────────────────────────────
//  /api/student-admin — staff side of student accounts and activity.
//  Trainers act on their own batches; the superadmin on all.
// ─────────────────────────────────────────────────────────────────────
const projectCode = require('../services/projectCode');
const express  = require('express');
const Student  = require('../models/Student');
const Batch    = require('../models/Batch');
const Cycle    = require('../models/Cycle');
const ProjectSubmission = require('../models/ProjectSubmission');
const { protect, canAccessBatch, seesAll } = require('../middleware/auth');
const codes    = require('../services/studentCodes');
const crypto   = require('crypto');
const perf     = require('../services/performance');
const sv       = require('../services/studentView');
const files = require('../services/fileStore');
const router   = express.Router();

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
async function newJoinCode(semester) {
  for (let i = 0; i < 20; i++) {
    const c = Array.from({ length: 6 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
    if (!(await Batch.exists({ semester, joinCode: c }))) return c;
  }
  throw new Error('Could not make a unique code');
}
// Changes: the batch's trainers (and admin). Reading: also management (viewer).
async function guard(req, res, batchId) {
  if (req.method === 'GET' && seesAll(req.user)) return true;
  if (!(await canAccessBatch(req.user, batchId))) { res.status(403).json({ message: 'Not your batch' }); return false; }
  return true;
}

// GET /api/student-admin/batch/:id — how students set up (mode), the batch code,
// each not-yet-set-up student's personal code (trainers/admin only), who has set up
router.get('/batch/:id', protect, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ message: 'Batch not found' });
    if (!(await guard(req, res, b._id))) return;
    if (!b.joinCode) { b.joinCode = await newJoinCode(b.semester); await b.save(); }
    const mode = await codes.mode();
    const students = await Student.find({ batch: b._id }).select('name roll rollTemporary demo login.activatedAt login.lastLoginAt github photo.contentType').sort('roll').setOptions({ withDemo: true }).lean();
    const showCodes = mode === 'personal' && req.user.role !== 'viewer';
    const codeOf = showCodes ? await codes.ensure(students.filter(s => !s.login?.activatedAt).map(s => s._id)) : new Map();
    res.json({ mode, joinCode: mode === 'batch' ? b.joinCode : null,
      activated: students.filter(s => s.login?.activatedAt && !s.demo).length, total: students.filter(s => !s.demo).length,
      students: students.map(s => ({ _id: s._id, name: s.name, roll: s.roll, rollTemporary: !!s.rollTemporary, github: s.github || '',
        activated: !!s.login?.activatedAt, lastLoginAt: s.login?.lastLoginAt || null, hasPhoto: !!s.photo?.contentType, demo: !!s.demo,
        ...(codeOf.has(String(s._id)) ? { setupCode: codeOf.get(String(s._id)) } : {}) })) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/student-admin/batch/:id/join-code — make a new code (old one stops working)
router.post('/batch/:id/join-code', protect, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ message: 'Batch not found' });
    if (!(await guard(req, res, b._id))) return;
    b.joinCode = await newJoinCode(b.semester); await b.save();
    res.json({ joinCode: b.joinCode });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/student-admin/student/:id/reset-password — student sets up again with the join code
router.post('/student/:id/reset-password', protect, async (req, res) => {
  try {
    const s = await Student.findById(req.params.id);
    if (!s) return res.status(404).json({ message: 'Student not found' });
    if (!(await guard(req, res, s.batch))) return;
    // the password goes, every sign-in of theirs ends, and a fresh personal code is made
    const setupCode = codes.make();
    s.login = { passwordHash: null, activatedAt: null, lastLoginAt: s.login?.lastLoginAt || null,
      setupCode, tokenVersion: (s.login?.tokenVersion || 0) + 1 };
    await s.save();
    const mode = await codes.mode();
    res.json({ ok: true, setupCode: mode === 'personal' ? setupCode : null,
      message: mode === 'personal' ? `${s.name} can set up again with roll number + code ${setupCode}.` : `${s.name} can now set up again with the batch code.` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/student-admin/student/:id/new-code — a new personal setup code (the old one stops working)
router.post('/student/:id/new-code', protect, async (req, res) => {
  try {
    const s = await Student.findById(req.params.id).select('+login.passwordHash');
    if (!s) return res.status(404).json({ message: 'Student not found' });
    if (!(await guard(req, res, s.batch))) return;
    if (s.login?.passwordHash) return res.status(400).json({ message: `${s.name} has already set up. Use Reset password instead.` });
    const setupCode = codes.make();
    await Student.updateOne({ _id: s._id }, { $set: { 'login.setupCode': setupCode } });
    res.json({ ok: true, setupCode });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/student-admin/cycle/:id/submissions
router.get('/cycle/:id/submissions', protect, async (req, res) => {
  try {
    const c = await Cycle.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'Cycle not found' });
    if (!(await guard(req, res, c.batch))) return;
    const subs = await ProjectSubmission.find({ cycle: c._id }).lean();   // code is small text; only names + line counts go out here
    const w = sv.submitWindow(c);
    res.json({ window: w,
      submissions: subs.map(x => ({ _id: x._id, student: x.student, githubUrl: x.githubUrl, liveUrl: x.liveUrl, note: x.note,
        submittedAt: x.submittedAt, late: x.late, hasScreenshot: !!x.screenshot?.contentType, files: projectCode.meta(x.files) })) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/student-admin/submission/:id/screenshot → { dataUrl }
router.get('/submission/:id/screenshot', protect, async (req, res) => {
  try {
    const x = await ProjectSubmission.findById(req.params.id).select('+screenshot.data batch screenshot.contentType screenshot.key');
    if (!x) return res.status(404).json({ message: 'Not found' });
    if (!(await guard(req, res, x.batch))) return;
    const dataUrl = await files.dataUrl(x.screenshot);
    if (!dataUrl) return res.status(404).json({ message: 'No screenshot' });
    res.json({ dataUrl });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/student-admin/submission/:id/code → { files: [{ name, language, code }] }
router.get('/submission/:id/code', protect, async (req, res) => {
  try {
    const x = await ProjectSubmission.findById(req.params.id).select('files batch student').populate('student', 'name roll').lean();
    if (!x) return res.status(404).json({ message: 'Not found' });
    if (!(await guard(req, res, x.batch))) return;
    res.json({ student: x.student ? { name: x.student.name, roll: x.student.roll } : null, files: x.files || [] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/student-admin/cycle/:id/submission { open: true, minutes? } | { open: false }
// The trainer's switch. Opening without minutes keeps it open until midnight (India time).
router.post('/cycle/:id/submission', protect, async (req, res) => {
  try {
    const c = await Cycle.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'Cycle not found' });
    if (!(await guard(req, res, c.batch))) return;
    const now = new Date();
    if (req.body.open) {
      const mins = Number(req.body.minutes);
      const midnight = perf.istToDate(`${sv.todayIST()}T23:59`);
      c.submitFrom = now;
      c.submitUntil = mins > 0 ? new Date(Math.min(now.getTime() + mins * 60000, midnight.getTime())) : midnight;
    } else {
      if (!c.submitFrom) return res.json({ ok: true, window: sv.submitWindow(c) });
      c.submitUntil = now;
    }
    c.submitBy = req.user._id;
    await c.save();
    res.json({ ok: true, window: sv.submitWindow(c) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/student-admin/pulse?batch=ID&from=YYYY-MM-DD&to=YYYY-MM-DD — batch totals per class day
router.get('/pulse', protect, async (req, res) => {
  try {
    if (!req.query.batch) return res.status(400).json({ message: 'batch required' });
    if (!(await guard(req, res, req.query.batch))) return;
    res.json({ days: await sv.pulseSummary(req.query.batch, req.query.from, req.query.to) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
