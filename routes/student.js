// ─────────────────────────────────────────────────────────────────────
//  /api/student — everything a STUDENT does after signing in.
//
//  Sign-in:  first time = roll number + the batch's join code (shown by the
//            trainer in class) + a new password. After that roll + password.
//  Student token: { sid, kind: 'student' } — staff routes reject it (no `id`).
//
//  A student sees: the cycle plan (topic + date only), their own attendance,
//  their own marks/category, the project submission box (open on project
//  day), the after-class "was today's plan covered?" question, and trainer
//  feedback forms the admin has opened. Never other students' data.
// ─────────────────────────────────────────────────────────────────────
const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const Student  = require('../models/Student');
const Batch    = require('../models/Batch');
const Cycle    = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const CycleMark = require('../models/CycleMark');
const Semester = require('../models/Semester');
const ProjectSubmission = require('../models/ProjectSubmission');
const ClassPulse = require('../models/ClassPulse');
const { FeedbackWindow, Feedback, QUESTIONS } = require('../models/Feedback');
const perf     = require('../services/performance');
const sv       = require('../services/studentView');
const router   = express.Router();

const signStudent = (s) => jwt.sign({ sid: s._id, kind: 'student' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rollRe = (roll) => new RegExp(`^\\s*${escapeRe(String(roll).trim())}\\s*$`, 'i');

// ── throttling (per IP + roll) ──
const WINDOW_MS = 15 * 60 * 1000, MAX_ATTEMPTS = 8;
const attempts = new Map();
const tkey = (req) => `${(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip}|${String(req.body?.roll || '').toLowerCase()}`;
const blocked = (k) => { const r = attempts.get(k); if (!r) return false; if (Date.now() - r.first > WINDOW_MS) { attempts.delete(k); return false; } return r.count >= MAX_ATTEMPTS; };
const fail = (k) => { const r = attempts.get(k); if (!r || Date.now() - r.first > WINDOW_MS) attempts.set(k, { count: 1, first: Date.now() }); else r.count++; };
setInterval(() => { const c = Date.now() - WINDOW_MS; for (const [k, v] of attempts) if (v.first < c) attempts.delete(k); }, WINDOW_MS).unref?.();

// ── middleware ──
async function protectStudent(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Please sign in' });
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.kind !== 'student' || !d.sid) return res.status(401).json({ message: 'Please sign in as a student' });
    const s = await Student.findById(d.sid).select('+login.passwordHash');
    if (!s || !s.login?.passwordHash) return res.status(401).json({ message: 'Please sign in again' });
    req.student = s;
    next();
  } catch { res.status(401).json({ message: 'Please sign in again' }); }
}

// POST /api/student/activate  { roll, code, password }
router.post('/activate', async (req, res) => {
  try {
    const { roll, code, password } = req.body || {};
    const k = tkey(req);
    if (blocked(k)) return res.status(429).json({ message: 'Too many tries. Wait 15 minutes.' });
    if (!roll || !code || !password) return res.status(400).json({ message: 'Roll number, batch code and a new password are needed.' });
    if (String(password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    const sem = await Semester.findOne({ status: 'active' });
    const batch = sem && await Batch.findOne({ semester: sem._id, joinCode: String(code).trim().toUpperCase() });
    if (!batch) { fail(k); return res.status(400).json({ message: 'That batch code is not right. Check the code your trainer showed.' }); }
    const matches = await Student.find({ batch: batch._id, roll: rollRe(roll) }).select('+login.passwordHash');
    if (!matches.length) { fail(k); return res.status(400).json({ message: 'This roll number is not in that batch. Ask your trainer to check the roster.' }); }
    if (matches.length > 1) return res.status(409).json({ message: 'Two students have this roll number in the batch. Ask your trainer to fix it.' });
    const s = matches[0];
    if (s.login?.passwordHash) return res.status(409).json({ message: 'This roll number is already set up. Sign in, or ask your trainer to reset your password.' });
    s.login = { passwordHash: await bcrypt.hash(String(password), 10), activatedAt: new Date(), lastLoginAt: new Date() };
    await s.save();
    attempts.delete(k);
    res.status(201).json({ token: signStudent(s), student: { id: s._id, name: s.name, roll: s.roll } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/student/login  { roll, password }
router.post('/login', async (req, res) => {
  try {
    const { roll, password } = req.body || {};
    const k = tkey(req);
    if (blocked(k)) return res.status(429).json({ message: 'Too many tries. Wait 15 minutes.' });
    if (!roll || !password) return res.status(400).json({ message: 'Roll number and password are needed.' });
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) return res.status(400).json({ message: 'No active semester.' });
    const list = await Student.find({ semester: sem._id, roll: rollRe(roll) }).select('+login.passwordHash');
    for (const s of list) {
      if (s.login?.passwordHash && await bcrypt.compare(String(password), s.login.passwordHash)) {
        s.login.lastLoginAt = new Date(); await s.save();
        attempts.delete(k);
        return res.json({ token: signStudent(s), student: { id: s._id, name: s.name, roll: s.roll } });
      }
    }
    fail(k);
    if (list.length && list.every(s => !s.login?.passwordHash))
      return res.status(401).json({ message: 'First time? Use "Set up my account" with the batch code from your trainer.' });
    res.status(401).json({ message: 'Roll number or password is wrong. Forgot it? Ask your trainer to reset it.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/student/me — the whole student home page in one call
router.get('/me', protectStudent, async (req, res) => {
  try { res.json(await sv.studentHome(req.student)); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/student/password { current, password }
router.put('/password', protectStudent, async (req, res) => {
  try {
    const { current, password } = req.body || {};
    if (!password || String(password).length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    if (!(await bcrypt.compare(String(current || ''), req.student.login.passwordHash)))
      return res.status(400).json({ message: 'Current password is wrong.' });
    req.student.login.passwordHash = await bcrypt.hash(String(password), 10);
    await req.student.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/student/github { github }
router.put('/github', protectStudent, async (req, res) => {
  const g = String(req.body?.github || '').trim();
  if (g && !/^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+\/?$/.test(g))
    return res.status(400).json({ message: 'Give your GitHub profile link, like https://github.com/yourname' });
  req.student.github = g; await req.student.save();
  res.json({ ok: true, github: g });
});

// POST /api/student/submission { cycleId, githubUrl, liveUrl, note, screenshot: { data(base64), contentType } }
router.post('/submission', protectStudent, async (req, res) => {
  try {
    const s = req.student, b = req.body || {};
    const cycle = await Cycle.findById(b.cycleId);
    if (!cycle || String(cycle.batch) !== String(s.batch)) return res.status(404).json({ message: 'Cycle not found' });
    const w = sv.submitWindow(cycle), now = new Date();
    if (now < w.from) return res.status(400).json({ message: `Submission opens ${sv.fmtIST(w.from)}.` });
    if (now > w.lateUntil) return res.status(400).json({ message: 'Submission is closed. Talk to your trainer.' });
    const gh = String(b.githubUrl || '').trim(), live = String(b.liveUrl || '').trim();
    if (!/^https?:\/\/(www\.)?github\.com\/.+/.test(gh)) return res.status(400).json({ message: 'Give the GitHub link of your project repository (https://github.com/…).' });
    if (live && !/^https?:\/\/.+/.test(live)) return res.status(400).json({ message: 'The live link must start with https://' });
    const set = { batch: s.batch, githubUrl: gh, liveUrl: live, note: String(b.note || '').slice(0, 500), submittedAt: now, late: now > w.until };
    if (b.screenshot?.data) {
      if (!/^image\/(png|jpe?g|webp)$/.test(b.screenshot.contentType || '')) return res.status(400).json({ message: 'Screenshot must be PNG, JPG or WEBP.' });
      if (String(b.screenshot.data).length > 2_000_000) return res.status(400).json({ message: 'Screenshot is too large (max ~1.5 MB).' });
      set.screenshot = { data: String(b.screenshot.data), contentType: b.screenshot.contentType };
    }
    await ProjectSubmission.updateOne({ cycle: cycle._id, student: s._id }, { $set: set }, { upsert: true });
    const sub = await ProjectSubmission.findOne({ cycle: cycle._id, student: s._id }).lean();
    res.status(201).json({ ok: true, submission: { githubUrl: sub.githubUrl, liveUrl: sub.liveUrl, note: sub.note, submittedAt: sub.submittedAt, late: sub.late, hasScreenshot: !!sub.screenshot?.contentType } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/student/pulse { covered: yes|partly|no, understanding: 1-5 } — today's class only
router.post('/pulse', protectStudent, async (req, res) => {
  try {
    const { covered, understanding } = req.body || {};
    if (!['yes', 'partly', 'no'].includes(covered)) return res.status(400).json({ message: 'Choose yes, partly or no.' });
    const u = Number(understanding);
    if (!(u >= 1 && u <= 5)) return res.status(400).json({ message: 'Rate your understanding from 1 to 5.' });
    const today = sv.todayIST();
    const cls = await sv.classOn(req.student.batch, today);
    if (!cls) return res.status(400).json({ message: 'There is no class planned for today.' });
    await ClassPulse.findOneAndUpdate({ batch: req.student.batch, student: req.student._id, date: today },
      { $set: { covered, understanding: u, planClass: cls.number } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/student/feedback { windowId, trainerId, ratings: {clarity,…}, comment }
router.post('/feedback', protectStudent, async (req, res) => {
  try {
    const s = req.student, b = req.body || {};
    const w = await FeedbackWindow.findById(b.windowId);
    const now = new Date();
    if (!w || !w.batches.some(x => String(x) === String(s.batch))) return res.status(404).json({ message: 'Feedback form not found.' });
    if (now < w.openFrom || now > w.openUntil) return res.status(400).json({ message: 'This feedback form is closed.' });
    const trainers = await sv.ratableTrainers(s.batch);
    if (!trainers.some(t => String(t._id) === String(b.trainerId))) return res.status(400).json({ message: 'That trainer is not in your batch.' });
    const ratings = {};
    for (const [k] of QUESTIONS) {
      const v = Number(b.ratings?.[k]);
      if (!(v >= 1 && v <= 5)) return res.status(400).json({ message: 'Answer every question (1 to 5).' });
      ratings[k] = v;
    }
    const exists = await Feedback.findOne({ window: w._id, trainer: b.trainerId, student: s._id });
    if (exists) return res.status(409).json({ message: 'You already gave feedback for this trainer.' });
    await Feedback.create({ window: w._id, batch: s.batch, trainer: b.trainerId, student: s._id, ratings, comment: String(b.comment || '').slice(0, 1000) });
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.__shared = { protectStudent };
module.exports = router;
