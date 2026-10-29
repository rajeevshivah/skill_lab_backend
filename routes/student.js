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
const projectCode = require('../services/projectCode');
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

// `v` = the student's login.tokenVersion: a password change or a trainer's reset bumps it,
// and every older sign-in of that student stops working at once.
const signStudent = (s) => jwt.sign({ sid: s._id, kind: 'student', org: s.org, v: s.login?.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '30d' });
const MIN_PW = 8;
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rollRe = (roll) => new RegExp(`^\\s*${escapeRe(String(roll).trim())}\\s*$`, 'i');

// ── failed-attempt limits: per address and per roll (services/throttle.js) ──
const signInLimit = require('../services/throttle').limiter({ perIp: 40, perAccount: 8 });

// ── middleware ──
async function protectStudent(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Please sign in' });
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.kind !== 'student' || !d.sid) return res.status(401).json({ message: 'Please sign in as a student' });
    const s = await Student.findById(d.sid).select('+login.passwordHash');
    if (!s || !s.login?.passwordHash) return res.status(401).json({ message: 'Please sign in again' });
    if ((d.v || 0) !== (s.login.tokenVersion || 0)) return res.status(401).json({ message: 'Your password was changed. Please sign in again.' });
    req.student = s;
    next();
  } catch { res.status(401).json({ message: 'Please sign in again' }); }
}

// POST /api/student/activate  { roll, code, password }
// First sign-in. `code` = the student's personal setup code (college setting
// "personal", the default) or the batch code shown in class (setting "batch").
// One answer for every wrong roll/code, so it can't be used to find out rolls.
router.post('/activate', async (req, res) => {
  try {
    const { roll, code, password } = req.body || {};
    if (signInLimit.blocked(req, roll)) return res.status(429).json({ message: 'Too many tries. Wait 15 minutes.' });
    if (!roll || !code || !password) return res.status(400).json({ message: 'Roll number, setup code and a new password are needed.' });
    if (String(password).length < MIN_PW) return res.status(400).json({ message: `Password must be at least ${MIN_PW} characters.` });
    const c = String(code).trim().toUpperCase();
    const wrong = () => { signInLimit.fail(req, roll); return res.status(400).json({ message: 'Roll number or code is not right. Check the code your trainer gave you.' }); };
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) return wrong();
    let matches;
    if ((await require('../services/studentCodes').mode()) === 'batch') {
      const batch = await Batch.findOne({ semester: sem._id, joinCode: c });
      if (!batch) return wrong();
      matches = await Student.find({ batch: batch._id, roll: rollRe(roll) }).select('+login.passwordHash +login.setupCode').setOptions({ withDemo: true });
    } else {
      matches = (await Student.find({ semester: sem._id, roll: rollRe(roll) }).select('+login.passwordHash +login.setupCode').setOptions({ withDemo: true }))
        .filter(x => x.login?.setupCode && x.login.setupCode === c);
    }
    if (!matches.length) return wrong();
    if (matches.length > 1) return res.status(409).json({ message: 'Your roll number is in this batch twice. Ask your trainer to tap "Merge" on the batch page, then set up again.' });
    const s = matches[0];
    if (s.login?.passwordHash) return res.status(409).json({ message: 'This roll number is already set up. Sign in, or ask your trainer to reset your password.' });
    s.login = { passwordHash: await bcrypt.hash(String(password), 10), activatedAt: new Date(), lastLoginAt: new Date(),
      setupCode: null, tokenVersion: (s.login?.tokenVersion || 0) + 1 };
    await s.save();
    signInLimit.clear(req, roll);
    res.status(201).json({ token: signStudent(s), student: { id: s._id, name: s.name, roll: s.roll } });
  } catch (err) { res.status(500).json({ message: 'Could not set up. Try again.' }); }
});

// POST /api/student/login  { roll, password }
router.post('/login', async (req, res) => {
  try {
    const { roll, password } = req.body || {};
    if (signInLimit.blocked(req, roll)) return res.status(429).json({ message: 'Too many tries. Wait 15 minutes.' });
    if (!roll || !password) return res.status(400).json({ message: 'Roll number and password are needed.' });
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) return res.status(400).json({ message: 'No active semester.' });
    const list = await Student.find({ semester: sem._id, roll: rollRe(roll) }).select('+login.passwordHash').setOptions({ withDemo: true });
    for (const s of list) {
      if (s.login?.passwordHash && await bcrypt.compare(String(password), s.login.passwordHash)) {
        s.login.lastLoginAt = new Date(); await s.save();
        signInLimit.clear(req, roll);
        return res.json({ token: signStudent(s), student: { id: s._id, name: s.name, roll: s.roll } });
      }
    }
    signInLimit.fail(req, roll);
    if (list.length && list.every(s => !s.login?.passwordHash))
      return res.status(401).json({ message: 'First time? Use "Set up my account" with the code from your trainer.' });
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
    if (!password || String(password).length < MIN_PW) return res.status(400).json({ message: `New password must be at least ${MIN_PW} characters.` });
    if (!(await bcrypt.compare(String(current || ''), req.student.login.passwordHash)))
      return res.status(400).json({ message: 'Current password is wrong.' });
    req.student.login.passwordHash = await bcrypt.hash(String(password), 10);
    req.student.login.tokenVersion = (req.student.login.tokenVersion || 0) + 1;   // other sign-ins end
    await req.student.save();
    res.json({ ok: true, token: signStudent(req.student) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/student/github { github }
router.put('/github', protectStudent, async (req, res) => {
  const g = String(req.body?.github || '').trim();
  if (g && !/^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+\/?$/.test(g))
    return res.status(400).json({ message: 'Give your GitHub profile link, like https://github.com/yourname' });
  req.student.github = g; await req.student.save();
  if (req.student.person) await require('../models/Person').updateOne({ _id: req.student.person }, { $set: { 'links.github': g } });
  res.json({ ok: true, github: g });
});

// PUT /api/student/photo { photo: "data:image/jpeg;base64,…" | null }
// The student's profile photo — also the photo on the Hall of Fame when they are Top 3.
router.put('/photo', protectStudent, async (req, res) => {
  try {
    const r = await require('../services/studentPhoto').set(req.student._id, req.body?.photo ?? null);
    res.json({ ok: true, ...r });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST /api/student/submission { cycleId, githubUrl, liveUrl, note, files: [{ name, language, code }], screenshot: { data(base64), contentType } }
// A GitHub link OR pasted code (or both). The screenshot is optional; the phone
// shrinks it first and the server refuses anything over 300 KB or not a real image.
const SHOT_MAX = 300 * 1024;
const fileStore = require('../services/fileStore');
router.post('/submission', protectStudent, async (req, res) => {
  try {
    if (req.student.demo) return res.status(201).json({ ok: true, demo: true, message: 'Demo account — this was not saved.' });
    const s = req.student, b = req.body || {};
    const cycle = await Cycle.findById(b.cycleId);
    if (!cycle || String(cycle.batch) !== String(s.batch)) return res.status(404).json({ message: 'Cycle not found' });
    const w = sv.submitWindow(cycle), now = new Date();
    if (!w.open) return res.status(400).json({ message: 'Submission is closed. Your trainer opens it in class on project day.' });
    const gh = String(b.githubUrl || '').trim(), live = String(b.liveUrl || '').trim();
    let files;
    try { files = projectCode.clean(b.files); } catch (e) { return res.status(400).json({ message: e.message }); }
    if (!gh && !files.length) return res.status(400).json({ message: 'Give your GitHub repository link, or paste your code below.' });
    if (gh && !/^https?:\/\/(www\.)?github\.com\/.+/.test(gh)) return res.status(400).json({ message: 'The GitHub link must look like https://github.com/yourname/project' });
    if (live && !/^https?:\/\/.+/.test(live)) return res.status(400).json({ message: 'The live link must start with https://' });
    const set = { batch: s.batch, githubUrl: gh, liveUrl: live, note: String(b.note || '').slice(0, 500), files, submittedAt: now, late: sv.todayIST() > w.projectDay };
    if (b.screenshot?.data) {
      let shot;
      try { shot = require('../services/studentPhoto').parse(`data:${b.screenshot.contentType};base64,${b.screenshot.data}`, SHOT_MAX); }
      catch (e) { return res.status(400).json({ message: e.message.replace('photo', 'screenshot') }); }
      const old = await ProjectSubmission.findOne({ cycle: cycle._id, student: s._id }).select('screenshot.key screenshot.contentType').lean();
      set.screenshot = await fileStore.store(shot, 'screens');
      if (old?.screenshot?.key) fileStore.remove(old.screenshot).catch(() => {});
    }
    await ProjectSubmission.updateOne({ cycle: cycle._id, student: s._id }, { $set: set }, { upsert: true });
    await require('../services/studentStats').recompute([s._id]);   // Top students: projects submitted
    const sub = await ProjectSubmission.findOne({ cycle: cycle._id, student: s._id }).lean();
    res.status(201).json({ ok: true, submission: sv.submissionView(sub) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/student/pulse { covered: yes|partly|no, understanding: 1-5 } — today's class only
router.post('/pulse', protectStudent, async (req, res) => {
  try {
    if (req.student.demo) return res.status(201).json({ ok: true, demo: true, message: 'Demo account — this was not saved.' });
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
    if (req.student.demo) return res.status(201).json({ ok: true, demo: true, message: 'Demo account — this was not saved.' });
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
