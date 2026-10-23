// ─────────────────────────────────────────────────────────────────────
//  /api/meeting — the screens used IN meetings (all staff can open them;
//  everything here is already visible to trainers elsewhere).
//    GET  /day?date=           daily review: per batch plan vs log vs students
//    GET  /review?period=      cycle review: per trainer, per batch, all numbers
//    GET  /notes?scope&date|period&batch   notes (visibility-filtered)
//    POST /notes               add a note
//    PATCH /notes/:id          edit text / mark done / reopen
//    DELETE /notes/:id         author or admin
// ─────────────────────────────────────────────────────────────────────
const express  = require('express');
const mongoose = require('mongoose');
const Batch    = require('../models/Batch');
const Cycle    = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const CycleMark = require('../models/CycleMark');
const DailyLog = require('../models/DailyLog');
const Semester = require('../models/Semester');
const Student  = require('../models/Student');
const ProjectSubmission = require('../models/ProjectSubmission');
const ClassPulse = require('../models/ClassPulse');
const MeetingNote = require('../models/MeetingNote');
const { FeedbackWindow, Feedback, QUESTIONS } = require('../models/Feedback');
const { protect } = require('../middleware/auth');
const perf     = require('../services/performance');
const sv       = require('../services/studentView');
const logRule  = require('../services/logRule');
const router   = express.Router();

const isAdmin = (u) => u.role === 'superadmin';
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const sid = (x) => x == null ? '' : String(x._id || x);

async function myBatchIds(user) {
  return (await Batch.find({ trainers: user._id }).select('_id').lean()).map(b => String(b._id));
}
// Can this user see this note?
function canSee(user, note, mine) {
  if (isAdmin(user)) return true;
  return sid(note.createdBy) === sid(user._id) || sid(note.trainer) === sid(user._id) || (note.batch && mine.includes(sid(note.batch)));
}
const noteView = (n) => ({ _id: n._id, scope: n.scope, date: n.date, period: n.period, batch: n.batch ? { _id: n.batch._id || n.batch, name: n.batch.name } : null,
  trainer: n.trainer ? { _id: n.trainer._id || n.trainer, name: n.trainer.name } : null, text: n.text, status: n.status,
  by: n.createdBy?.name || '', byId: sid(n.createdBy), at: n.createdAt, doneBy: n.doneBy?.name || '', doneAt: n.doneAt });
const populateNote = (q) => q.populate('batch', 'name').populate('trainer', 'name').populate('createdBy', 'name').populate('doneBy', 'name');

// ── Daily review ──
// Everything for all batches is loaded in a few parallel bulk queries (one round trip
// per kind of data, not per batch).
async function dayView(user, date) {
  const sem = await Semester.findOne({ status: 'active' });
  if (!sem) return { date, batches: [] };
  const day = perf.ymdToDay(date);
  const [cycles, mine, holOf, notes] = await Promise.all([
    Cycle.find({ semester: sem._id, startDate: { $lte: day }, endDate: { $gte: day } }).select('number batch')
      .populate({ path: 'batch', select: 'name track trainers', populate: { path: 'trainers', select: 'name isActive' } }).lean(),
    myBatchIds(user),
    sv.holidayFinder(date, date),
    // notes for that day + still-open notes from earlier days
    populateNote(MeetingNote.find({ semester: sem._id, scope: 'day', $or: [{ date }, { status: 'open', date: { $lt: date } }] }).sort('date createdAt')).lean(),
  ]);
  const live = cycles.filter(c => c.batch);
  const bids = live.map(c => c.batch._id);
  const [plans, logs, pulseOf] = await Promise.all([
    CyclePlan.find({ cycle: { $in: live.map(c => c._id) } }).select('cycle classes').lean(),
    DailyLog.find({ batch: { $in: bids }, date: day }).populate('loggedBy', 'name').populate('firstLoggedBy', 'name').lean(),
    sv.pulseFinder(bids.map(b => ({ batch: b, from: date, to: date }))),
  ]);
  const planOf = new Map(plans.map(p => [sid(p.cycle), p]));
  const logOf = new Map(logs.map(l => [sid(l.batch), l]));
  const out = [];
  for (const c of live) {
    const b = c.batch;
    const plan = planOf.get(sid(c._id));
    const planned = (plan?.classes || []).filter(k => k.date === date).map(k => ({ number: k.number, title: k.title, notes: k.notes }));
    const log = logOf.get(sid(b._id)) || null;
    const holiday = holOf(b._id, date);
    if (!planned.length && !log && !holiday) continue;     // no class for this batch that day
    const pulse = pulseOf(b._id, date, date)[0] || null;
    const present = log?.attendance?.filter(a => a.present).length ?? null;
    const loggedClass = log?.planClass != null ? (plan?.classes || []).find(k => k.number === log.planClass) : null;
    out.push({
      batchId: b._id, batch: b.name, track: b.track || '', cycle: { id: c._id, number: c.number }, mine: mine.includes(String(b._id)),
      trainers: (b.trainers || []).filter(t => t.isActive !== false && !perf.isReviewer(t)).map(t => t.name),
      holiday, planned,
      log: log ? {
        status: log.status, notes: log.notes, planClass: log.planClass, planClassTitle: loggedClass?.title || null,
        github: log.github || '', by: (log.firstLoggedBy || log.loggedBy)?.name || '',
        loggedAt: log.createdAt, sameDay: perf.istYmd(log.createdAt) <= date,
        attendance: log.attendanceTaken ? { present, total: log.attendance.length } : null,
        missing: date >= logRule.RULE_FROM ? logRule.missingParts(log) : [],
      } : null,
      pulse: pulse ? { ...pulse, mismatch: !!log && log.status === 'done' && pulse.responses >= 5 && pulse.coveredPct < 50 } : null,
    });
  }
  out.sort((a, b) => a.batch.localeCompare(b.batch));
  const visible = notes.filter(n => canSee(user, n, mine)).map(noteView);
  return { date, isAdmin: isAdmin(user), batches: out, notes: visible };
}

router.get('/day', protect, async (req, res) => {
  try {
    const date = isYmd(req.query.date) ? req.query.date : sv.todayIST();
    res.json(await dayView(req.user, date));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Cycle review ──
async function reviewView(user, period) {
  const sem = await Semester.findOne({ status: 'active' });
  if (!sem) return { periods: [], trainers: [] };
  const { buildDashboard } = require('./performance').__shared;
  const [dash, mine] = await Promise.all([buildDashboard(sem, { period }), myBatchIds(user)]);
  const rows = dash.rows;
  const cycleIds = rows.map(r => r.cycleId), batchIds = rows.map(r => r.batchId);
  const minS = rows.reduce((m, r) => (r.start < m ? r.start : m), '9999-12-31');
  const maxE = rows.reduce((m, r) => (r.end > m ? r.end : m), '0000-01-01');
  const today = sv.todayIST();
  // One bulk query per kind of data for every row (was ~10 queries per batch, one after another).
  const [plans, logs, holOf, marks, studentCounts, subCounts, pulseOf, windows, notes] = await Promise.all([
    CyclePlan.find({ cycle: { $in: cycleIds } }).select('cycle classes.date').lean(),
    rows.length ? DailyLog.find({ $or: rows.map(r => ({ batch: r.batchId, date: { $gte: perf.ymdToDay(r.start), $lte: perf.ymdToDay(r.end) } })) }).select('batch date status').lean() : [],
    sv.holidayFinder(minS, maxE),
    CycleMark.find({ cycle: { $in: cycleIds } }).select('cycle status category').lean(),
    Student.aggregate([{ $match: { batch: { $in: batchIds.map(x => new mongoose.Types.ObjectId(String(x))) } } }, { $group: { _id: '$batch', n: { $sum: 1 } } }]),
    ProjectSubmission.aggregate([{ $match: { cycle: { $in: cycleIds.map(x => new mongoose.Types.ObjectId(String(x))) } } }, { $group: { _id: '$cycle', n: { $sum: 1 } } }]),
    sv.pulseFinder(rows.map(r => ({ batch: r.batchId, from: r.start, to: r.end }))),
    rows.length ? FeedbackWindow.find({ batches: { $in: batchIds }, openFrom: { $lte: perf.istToDate(`${maxE}T23:59`) }, openUntil: { $gte: perf.istToDate(`${minS}T00:00`) } }).select('batches openFrom openUntil').lean() : [],
    populateNote(MeetingNote.find({ semester: sem._id, scope: 'cycle', period: dash.period }).sort('createdAt')).lean(),
  ]);
  const feedback = windows.length ? await Feedback.find({ window: { $in: windows.map(w => w._id) }, batch: { $in: batchIds } }).select('window batch trainer ratings').lean() : [];
  const planOf = new Map(plans.map(p => [sid(p.cycle), p]));
  const nStudents = new Map(studentCounts.map(x => [sid(x._id), x.n]));
  const nSubs = new Map(subCounts.map(x => [sid(x._id), x.n]));
  const byTrainer = new Map();
  for (const r of rows) {
    const s = r.start, e = r.end;
    const classes = (planOf.get(sid(r.cycleId))?.classes || []).filter(k => k.date && k.date >= s && k.date <= e);
    const myLogs = logs.filter(l => sid(l.batch) === sid(r.batchId) && perf.dayYmd(l.date) >= s && perf.dayYmd(l.date) <= e);
    const status = (st) => myLogs.filter(l => l.status === st).length;
    const due = classes.filter(k => k.date <= today && !holOf(r.batchId, k.date));
    const loggedDays = new Set(myLogs.map(l => perf.dayYmd(l.date)));
    const myMarks = marks.filter(m => sid(m.cycle) === sid(r.cycleId));
    const cat = (k) => myMarks.filter(m => m.status === 'evaluated' && m.category === k).length;
    const students = nStudents.get(sid(r.batchId)) || 0;
    const subs = nSubs.get(sid(r.cycleId)) || 0;
    const pulse = pulseOf(r.batchId, s, e);
    const pAvg = (f) => pulse.length ? Math.round(10 * pulse.reduce((a, p) => a + p[f], 0) / pulse.length) / 10 : null;
    const myWindows = new Set(windows.filter(w => (w.batches || []).some(b => sid(b) === sid(r.batchId))
      && w.openFrom <= perf.istToDate(`${e}T23:59`) && w.openUntil >= perf.istToDate(`${s}T00:00`)).map(w => sid(w._id)));
    const facts = {
      batch: r.batch, batchId: r.batchId, cycleId: r.cycleId, number: r.number, start: s, end: e, projectDate: r.projectDate,
      tracked: r.tracked, overall: r.overall, lateBy: r.lateBy, who: r.who,
      plan: { classes: classes.length, due: due.length, notLogged: due.filter(k => !loggedDays.has(k.date)).length,
        done: status('done'), partial: status('partial'), notDone: status('not-covered'), noClass: status('no-class') },
      marks: { students, evaluated: myMarks.filter(m => m.status === 'evaluated').length,
        excellent: cat('excellent'), moderate: cat('moderate'), basic: cat('basic'), zero: cat('zero') },
      submissions: { submitted: subs, students },
      pulse: { days: pulse.length, coveredPct: pAvg('coveredPct'), understanding: pAvg('understanding') },
    };
    for (const p of r.perTrainer) {
      const t = byTrainer.get(p.id) || { id: p.id, name: p.name, batches: [] };
      let fb = null;
      if (myWindows.size) {
        const list = feedback.filter(f => myWindows.has(sid(f.window)) && sid(f.batch) === sid(r.batchId) && sid(f.trainer) === String(p.id));
        const n = list.length, show = n && (isAdmin(user) || n >= 5);
        fb = { responses: n, overall: show ? Math.round(10 * list.reduce((a, f) => a + QUESTIONS.reduce((x, [k]) => x + f.ratings[k], 0) / QUESTIONS.length, 0) / n) / 10 : null };
      }
      t.batches.push({ ...facts, score: p.score, items: p.items, isLead: p.isLead, owns: p.owns, feedback: fb });
      byTrainer.set(p.id, t);
    }
  }
  const scores = new Map(dash.trainers.map(t => [String(t.id), t]));
  const trainers = [...byTrainer.values()].map(t => ({
    ...t, thisCycle: scores.get(String(t.id))?.thisCycle ?? null, semesterAvg: scores.get(String(t.id))?.semesterAvg ?? null,
    notes: notes.filter(n => sid(n.trainer) === String(t.id) && canSee(user, n, mine)).map(noteView),
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { isAdmin: isAdmin(user), periods: dash.periods, period: dash.period, trainers,
    generalNotes: notes.filter(n => !n.trainer && canSee(user, n, mine)).map(noteView) };
}

router.get('/review', protect, async (req, res) => {
  try { res.json(await reviewView(req.user, isYmd(req.query.period) ? req.query.period : null)); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Notes ──
router.get('/notes', protect, async (req, res) => {
  try {
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) return res.json({ notes: [] });
    const q = { semester: sem._id };
    if (['day', 'cycle'].includes(req.query.scope)) q.scope = req.query.scope;
    if (isYmd(req.query.date)) q.date = req.query.date;
    if (isYmd(req.query.period)) q.period = req.query.period;
    if (mongoose.isValidObjectId(req.query.batch)) q.batch = req.query.batch;
    if (mongoose.isValidObjectId(req.query.trainer)) q.trainer = req.query.trainer;
    if (['open', 'done'].includes(req.query.status)) q.status = req.query.status;
    const mine = await myBatchIds(req.user);
    const list = await populateNote(MeetingNote.find(q).sort('-createdAt').limit(200)).lean();
    res.json({ notes: list.filter(n => canSee(req.user, n, mine)).map(noteView) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// body: { scope, date | period, batchId?, trainerId?, text }
// Admin: any note. Trainer: notes on their own batches (or about themselves).
router.post('/notes', protect, async (req, res) => {
  try {
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) return res.status(400).json({ message: 'No active semester' });
    const { scope, date, period, batchId, trainerId } = req.body;
    const text = String(req.body.text || '').trim();
    if (!['day', 'cycle'].includes(scope)) return res.status(400).json({ message: 'scope must be day or cycle' });
    if (scope === 'day' && !isYmd(date)) return res.status(400).json({ message: 'date required' });
    if (scope === 'cycle' && !isYmd(period)) return res.status(400).json({ message: 'period required' });
    if (!text) return res.status(400).json({ message: 'Write the note.' });
    if (batchId && !mongoose.isValidObjectId(batchId)) return res.status(400).json({ message: 'Bad batch' });
    if (trainerId && !mongoose.isValidObjectId(trainerId)) return res.status(400).json({ message: 'Bad trainer' });
    if (!isAdmin(req.user)) {
      const mine = await myBatchIds(req.user);
      const okBatch = batchId && mine.includes(String(batchId));
      const okSelf = trainerId && String(trainerId) === String(req.user._id);
      if (!okBatch && !okSelf) return res.status(403).json({ message: 'You can add notes only for your own batches.' });
      if (trainerId && String(trainerId) !== String(req.user._id)) return res.status(403).json({ message: 'Only the admin writes notes about another trainer.' });
    }
    const n = await MeetingNote.create({ semester: sem._id, scope, date: scope === 'day' ? date : null, period: scope === 'cycle' ? period : null,
      batch: batchId || null, trainer: trainerId || null, text: text.slice(0, 2000), createdBy: req.user._id });
    res.status(201).json({ note: noteView(await populateNote(MeetingNote.findById(n._id)).lean()) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// body: { text?, status? 'open'|'done' } — text: author/admin; status: also the trainer/batch trainers concerned
router.patch('/notes/:id', protect, async (req, res) => {
  try {
    const n = await MeetingNote.findById(req.params.id);
    if (!n) return res.status(404).json({ message: 'Note not found' });
    const mine = await myBatchIds(req.user);
    if (!canSee(req.user, n, mine)) return res.status(403).json({ message: 'Not your note' });
    const author = isAdmin(req.user) || sid(n.createdBy) === sid(req.user._id);
    if (req.body.text !== undefined) {
      if (!author) return res.status(403).json({ message: 'Only the author or admin can edit the text.' });
      const t = String(req.body.text).trim(); if (!t) return res.status(400).json({ message: 'Note cannot be empty.' });
      n.text = t.slice(0, 2000);
    }
    if (req.body.status === 'done' && n.status !== 'done') { n.status = 'done'; n.doneBy = req.user._id; n.doneAt = new Date(); }
    if (req.body.status === 'open') { n.status = 'open'; n.doneBy = null; n.doneAt = null; }
    await n.save();
    res.json({ note: noteView(await populateNote(MeetingNote.findById(n._id)).lean()) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/notes/:id', protect, async (req, res) => {
  try {
    const n = await MeetingNote.findById(req.params.id);
    if (!n) return res.status(404).json({ message: 'Note not found' });
    if (!isAdmin(req.user) && sid(n.createdBy) !== sid(req.user._id)) return res.status(403).json({ message: 'Only the author or admin can delete it.' });
    await MeetingNote.deleteOne({ _id: n._id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.__shared = { dayView, reviewView };
module.exports = router;
