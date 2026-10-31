// ─────────────────────────────────────────────────────────────────────
//  /api/student — everything a STUDENT does after signing in.
//
//  ONE sign-in per student (Person.login, services/studentAccess.js) for every
//  module. First time = roll + setup code (their personal code from the trainer,
//  or the batch code shown in class — college setting) + a new password.
//  Student token: { pid, kind: 'student' } (older { sid } tokens still work
//  until they expire). Staff routes reject both (no `id`).
//
//  Training screens work on one of the student's batch places at a time: the
//  one in the x-place header (if it is theirs), else the current one.
//  A student sees only their own data.
// ─────────────────────────────────────────────────────────────────────
const projectCode = require('../services/projectCode');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const Student  = require('../models/Student');
const Person   = require('../models/Person');
const Batch    = require('../models/Batch');
const Cycle    = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const CycleMark = require('../models/CycleMark');
const Semester = require('../models/Semester');
const Organization = require('../models/Organization');
const ProjectSubmission = require('../models/ProjectSubmission');
const ClassPulse = require('../models/ClassPulse');
const { FeedbackWindow, Feedback, QUESTIONS } = require('../models/Feedback');
const perf     = require('../services/performance');
const sv       = require('../services/studentView');
const access   = require('../services/studentAccess');
const profile  = require('../services/profile');
const people   = require('../services/people');
const tenant   = require('../services/tenant');
const router   = express.Router();

const MIN_PW = 8;
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rollRe = (roll) => new RegExp(`^\\s*${escapeRe(String(roll).trim())}\\s*$`, 'i');
const activeSemester = () => Semester.findOne({ status: 'active' }).sort('-startDate').select('_id').lean();

// ── failed-attempt limits: per address and per roll (services/throttle.js) ──
const signInLimit = require('../services/throttle').limiter({ perIp: 40, perAccount: 8 });

// ── middleware ──
// req.person = the student; req.places = their batch places; req.student = the
// place this request works on (null when they are in no batch).
async function protectStudent(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Please sign in' });
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.kind !== 'student' || (!d.pid && !d.sid)) return res.status(401).json({ message: 'Please sign in as a student' });
    let person, fromPlace = null;
    if (d.pid) {
      person = await Person.findById(d.pid).select('+login.passwordHash');
      if (!person || !person.login?.passwordHash) return res.status(401).json({ message: 'Please sign in again' });
      if ((d.v || 0) !== (person.login.tokenVersion || 0)) return res.status(401).json({ message: 'Your password was changed. Please sign in again.' });
    } else {   // a sign-in made before the move: still valid until it expires (or a sign-out / reset)
      fromPlace = await Student.findById(d.sid).select('person login.tokenVersion').setOptions({ withDemo: true }).lean();
      if (!fromPlace?.person || (d.v || 0) !== (fromPlace.login?.tokenVersion || 0)) return res.status(401).json({ message: 'Please sign in again' });
      person = await Person.findById(fromPlace.person).select('+login.passwordHash');
      if (!person) return res.status(401).json({ message: 'Please sign in again' });
      if (!person.login?.passwordHash) { await access.moveLogins({ personIds: [person._id] }); person = await Person.findById(fromPlace.person).select('+login.passwordHash'); }
      if (!person?.login?.passwordHash) return res.status(401).json({ message: 'Please sign in again' });
    }
    const sem = await activeSemester();
    req.person = person;
    req.places = await access.placesOf(person._id, sem?._id);
    const asked = req.headers['x-place'];
    const pick = req.places.find(p => p.studentId === String(asked)) || (fromPlace && req.places.find(p => p.studentId === String(fromPlace._id))) || req.places[0];
    req.student = pick ? await Student.findById(pick.studentId).setOptions({ withDemo: true }) : null;
    req.demo = !!(person.demo || req.student?.demo);
    next();
  } catch { res.status(401).json({ message: 'Please sign in again' }); }
}
// training screens need a batch place
const needPlace = (req, res, next) => req.student ? next() : res.status(404).json({ message: 'You are not in a training batch yet.' });

// has a photo: on the person, or (set before the move) on a batch place
const photoOf = async (p) => !!p.photo?.contentType || !!(await Student.exists({ person: p._id, 'photo.contentType': { $ne: null } }).setOptions({ withDemo: true }));

// The person behind a training record (links it if it is not linked yet).
async function personOf(rec) {
  if (!rec.person) await people.syncIdentity(rec, null);
  return rec.person ? Person.findById(rec.person).select('+login.passwordHash') : null;
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
    const sem = await activeSemester();
    if (!sem) return wrong();
    let matches;
    if ((await require('../services/studentCodes').mode()) === 'batch') {
      const batch = await Batch.findOne({ semester: sem._id, joinCode: c });
      if (!batch) return wrong();
      matches = await Student.find({ batch: batch._id, roll: rollRe(roll) }).select('+login.setupCode').setOptions({ withDemo: true });
    } else {
      matches = (await Student.find({ semester: sem._id, roll: rollRe(roll) }).select('+login.setupCode').setOptions({ withDemo: true }))
        .filter(x => x.login?.setupCode && x.login.setupCode === c);
    }
    if (!matches.length) return wrong();
    if (matches.length > 1) return res.status(409).json({ message: 'Your roll number is in this batch twice. Ask your trainer to tap "Merge" on the batch page, then set up again.' });
    const person = await personOf(matches[0]);
    if (!person) return wrong();
    await access.moveLogins({ personIds: [person._id] });   // an older sign-in of theirs counts as "already set up"
    const fresh = await Person.findById(person._id).select('+login.passwordHash');
    if (fresh.login?.passwordHash) return res.status(409).json({ message: 'This roll number is already set up. Sign in, or ask your trainer to reset your password.' });
    fresh.login = { passwordHash: await bcrypt.hash(String(password), 10), activatedAt: new Date(), lastLoginAt: new Date(),
      tokenVersion: (fresh.login?.tokenVersion || 0) + 1 };
    await fresh.save();
    await Student.updateMany({ person: fresh._id }, { $set: { 'login.setupCode': null } }).setOptions({ withDemo: true });   // codes used up
    signInLimit.clear(req, roll);
    res.status(201).json({ token: access.sign(fresh), student: { id: fresh._id, name: fresh.name, roll: fresh.roll } });
  } catch (err) { res.status(500).json({ message: 'Could not set up. Try again.' }); }
});

// POST /api/student/login  { roll, password }
router.post('/login', async (req, res) => {
  try {
    const { roll, password } = req.body || {};
    if (signInLimit.blocked(req, roll)) return res.status(429).json({ message: 'Too many tries. Wait 15 minutes.' });
    if (!roll || !password) return res.status(400).json({ message: 'Roll number and password are needed.' });
    let list = await Person.find({ roll: rollRe(roll) }).select('+login.passwordHash');
    if (!list.length) {   // a training record not linked yet → link it, then look again
      const rec = await Student.findOne({ roll: rollRe(roll), person: null }).setOptions({ withDemo: true });
      if (rec) { await personOf(rec); list = await Person.find({ roll: rollRe(roll) }).select('+login.passwordHash'); }
    }
    if (list.some(p => !p.login?.passwordHash)) {   // set up before the move → copy it over first
      await access.moveLogins({ personIds: list.map(p => p._id) });
      list = await Person.find({ roll: rollRe(roll) }).select('+login.passwordHash');
    }
    for (const p of list) {
      if (p.login?.passwordHash && await bcrypt.compare(String(password), p.login.passwordHash)) {
        p.login.lastLoginAt = new Date(); await p.save();
        signInLimit.clear(req, roll);
        return res.json({ token: access.sign(p), student: { id: p._id, name: p.name, roll: p.roll } });
      }
    }
    signInLimit.fail(req, roll);
    if (list.length && list.every(p => !p.login?.passwordHash))
      return res.status(401).json({ message: 'First time? Use "Set up my account" with the code from your trainer.' });
    res.status(401).json({ message: 'Roll number or password is wrong. Forgot it? Ask your trainer to reset it.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// What the student app shows around the modules: who they are, their batch
// places, which modules the college has, how complete their profile is.
async function frame(req) {
  const [org, fields] = await Promise.all([
    Organization.findById(tenant.currentOrg()).select('modules name shortName programName').lean(),
    profile.studentFields(),
  ]);
  const files = require('../services/fileStore');
  const withPhoto = await Person.findById(req.person._id).select('+photo.data photo').lean();
  // the photo: on the main record, or (set before the move) on the batch place
  let photo = files.publicUrl(withPhoto?.photo) || await files.dataUrl(withPhoto?.photo);
  if (!photo && req.student?.photo?.contentType) photo = files.publicUrl(req.student.photo) || await files.dataUrl(req.student.photo);
  const hasPhoto = !!photo || await photoOf(req.person);
  return {
    person: { id: req.person._id, name: req.person.name, roll: req.person.roll, rollTemporary: !!req.person.rollTemporary, hasPhoto, photo: photo || null },
    places: req.places, place: req.student ? String(req.student._id) : null,
    modules: { training: org?.modules?.training !== false },
    college: { name: org?.shortName || org?.name || '', programName: org?.programName || 'Skill Lab' },
    profile: profile.completion(req.person, fields, hasPhoto),
    demo: req.demo,
  };
}

// GET /api/student/me — the whole student home page in one call
// (the training part — today, cycle, marks, project — for the current place, plus the frame)
router.get('/me', protectStudent, async (req, res) => {
  try {
    const home = req.student ? await sv.studentHome(req.student) : {};
    res.json({ ...home, ...await frame(req) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/student/profile — what they have filled in, the college's fields for students, completion
router.get('/profile', protectStudent, async (req, res) => {
  try {
    const fields = await profile.studentFields();
    const hasPhoto = await photoOf(req.person);
    res.json({ profile: profile.view(req.person, fields, hasPhoto) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/student/profile { phone, email, github, linkedin, portfolio, custom: {key: value}, consent: true (first time) }
router.put('/profile', protectStudent, async (req, res) => {
  try {
    const fields = await profile.studentFields();
    let set;
    try { set = await profile.changesFrom(req.person, req.body || {}, fields); }
    catch (e) { if (e instanceof profile.ProfileError) return res.status(400).json({ message: e.message }); throw e; }
    if (req.demo) return res.json({ ok: true, demo: true, message: 'Demo account — this was not saved.' });
    if (Object.keys(set).length) await Person.updateOne({ _id: req.person._id }, { $set: set });
    if (set['links.github'] !== undefined)   // the batch places show the same GitHub
      await Student.updateMany({ person: req.person._id }, { $set: { github: set['links.github'] } }).setOptions({ withDemo: true });
    const p = await Person.findById(req.person._id).lean();
    const hasPhoto = await photoOf(p);
    res.json({ ok: true, profile: profile.view(p, fields, hasPhoto) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/student/password { current, password }
router.put('/password', protectStudent, async (req, res) => {
  try {
    const { current, password } = req.body || {};
    if (!password || String(password).length < MIN_PW) return res.status(400).json({ message: `New password must be at least ${MIN_PW} characters.` });
    if (!(await bcrypt.compare(String(current || ''), req.person.login.passwordHash)))
      return res.status(400).json({ message: 'Current password is wrong.' });
    req.person.login.passwordHash = await bcrypt.hash(String(password), 10);
    await req.person.save();
    await access.bump(req.person._id);   // other sign-ins end
    res.json({ ok: true, token: access.sign(await Person.findById(req.person._id)) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/student/github { github } — same as the GitHub field of the profile
router.put('/github', protectStudent, async (req, res) => {
  const g = String(req.body?.github || '').trim();
  if (g && !/^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+\/?$/.test(g))
    return res.status(400).json({ message: 'Give your GitHub profile link, like https://github.com/yourname' });
  if (req.demo) return res.json({ ok: true, demo: true, github: g });
  await Person.updateOne({ _id: req.person._id }, { $set: { 'links.github': g } });
  await Student.updateMany({ person: req.person._id }, { $set: { github: g } }).setOptions({ withDemo: true });
  res.json({ ok: true, github: g });
});

// PUT /api/student/photo { photo: "data:image/jpeg;base64,…" | null }
// The student's photo on every batch place — also on the Hall of Fame when they are Top 3.
router.put('/photo', protectStudent, async (req, res) => {
  try {
    const sp = require('../services/studentPhoto');
    const p = sp.parse(req.body?.photo ?? null);   // checks it is a real, small image (or null = remove)
    if (req.demo) return res.json({ ok: true, demo: true, hasPhoto: !!p });
    const stored = await require('../services/fileStore').store(p, 'photos');   // stored once, used by every place
    await Person.updateOne({ _id: req.person._id }, { $set: { photo: stored } });
    await Student.updateMany({ person: req.person._id }, { $set: { photo: stored } }).setOptions({ withDemo: true });
    let hallOfFame = 0;
    for (const pl of req.places) hallOfFame += (await sp.sync(pl.studentId)) || 0;
    res.json({ ok: true, hasPhoto: !!p, hallOfFame });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST /api/student/submission { cycleId, githubUrl, liveUrl, note, files: [{ name, language, code }], screenshot: { data(base64), contentType } }
// A GitHub link OR pasted code (or both). The screenshot is optional; the phone
// shrinks it first and the server refuses anything over 300 KB or not a real image.
const SHOT_MAX = 300 * 1024;
const fileStore = require('../services/fileStore');
router.post('/submission', protectStudent, needPlace, async (req, res) => {
  try {
    if (req.demo) return res.status(201).json({ ok: true, demo: true, message: 'Demo account — this was not saved.' });
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
router.post('/pulse', protectStudent, needPlace, async (req, res) => {
  try {
    if (req.demo) return res.status(201).json({ ok: true, demo: true, message: 'Demo account — this was not saved.' });
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
router.post('/feedback', protectStudent, needPlace, async (req, res) => {
  try {
    if (req.demo) return res.status(201).json({ ok: true, demo: true, message: 'Demo account — this was not saved.' });
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
