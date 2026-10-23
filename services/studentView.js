// Shared helpers for the student side (routes/student.js) and the staff views
// of student activity (routes/studentAdmin.js, routes/feedback.js).
const Batch     = require('../models/Batch');
const Cycle     = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const CycleMark = require('../models/CycleMark');
const ProjectSubmission = require('../models/ProjectSubmission');
const ClassPulse = require('../models/ClassPulse');
const { FeedbackWindow, Feedback, QUESTIONS } = require('../models/Feedback');
const perf = require('./performance');

const IST = 330 * 60 * 1000;
const todayIST = () => perf.istYmd(new Date());
const fmtIST = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// Project submission window. Default: the whole project day (India time).
// Late submissions are still accepted (and marked late) until the cycle deadline.
function submitWindow(cycle) {
  const pd = perf.dayYmd(cycle.track?.projectDate || cycle.endDate);
  const from = cycle.submitFrom || perf.istToDate(`${pd}T00:00`);
  const until = cycle.submitUntil || perf.istToDate(`${pd}T23:59`);
  const dl = perf.deadlineOf(cycle);
  return { projectDay: pd, from, until, lateUntil: dl > until ? dl : until, custom: !!(cycle.submitFrom || cycle.submitUntil) };
}

// The cycle a batch is in today; else the next one; else the latest.
async function currentCycle(batchId) {
  const cycles = await Cycle.find({ batch: batchId }).sort('startDate').lean();
  const t = todayIST();
  return cycles.find(c => perf.dayYmd(c.startDate) <= t && perf.dayYmd(c.endDate) >= t)
    || cycles.find(c => perf.dayYmd(c.startDate) > t)
    || cycles[cycles.length - 1] || null;
}

// The planned class of a batch on a given day (from the cycle plan), or null.
async function classOn(batchId, ymd) {
  const cycles = await Cycle.find({ batch: batchId }).select('_id startDate endDate').lean();
  const c = cycles.find(x => perf.dayYmd(x.startDate) <= ymd && perf.dayYmd(x.endDate) >= ymd);
  if (!c) return null;
  const plan = await CyclePlan.findOne({ cycle: c._id }).select('classes.number classes.title classes.date').lean();
  const k = (plan?.classes || []).find(x => x.date === ymd);
  return k ? { number: k.number, title: k.title, date: k.date, cycle: c._id } : null;
}

// Trainers students can rate: active, not a "(Review)" account.
async function ratableTrainers(batchId) {
  const b = await Batch.findById(batchId).populate('trainers', 'name isActive').lean();
  return (b?.trainers || []).filter(t => t.isActive !== false && !perf.isReviewer(t));
}

async function studentHome(s) {
  const batch = await Batch.findById(s.batch).populate('trainers', 'name isActive').lean();
  const trainers = (batch?.trainers || []).filter(t => t.isActive !== false && !perf.isReviewer(t));
  const today = todayIST(), now = new Date();
  const cycle = await currentCycle(s.batch);

  let cycleView = null, project = null;
  if (cycle) {
    const plan = await CyclePlan.findOne({ cycle: cycle._id }).select('classes.number classes.title classes.date').lean();
    const start = perf.dayYmd(cycle.startDate), end = perf.dayYmd(cycle.endDate);
    const myPulse = await ClassPulse.find({ student: s._id, date: { $gte: start, $lte: end } }).lean();
    const pulseBy = new Map(myPulse.map(p => [p.date, p]));
    const classes = (plan?.classes || []).filter(k => !k.date || (k.date >= start && k.date <= end))
      .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.number - b.number)
      .map(k => ({ number: k.number, title: k.title, date: k.date || null,
        when: !k.date ? 'unscheduled' : k.date < today ? 'past' : k.date === today ? 'today' : 'upcoming',
        myPulse: k.date && pulseBy.has(k.date) ? { covered: pulseBy.get(k.date).covered, understanding: pulseBy.get(k.date).understanding } : null }));
    cycleView = { id: cycle._id, number: cycle.number, start, end, classes };

    const w = submitWindow(cycle);
    const sub = await ProjectSubmission.findOne({ cycle: cycle._id, student: s._id }).lean();
    project = {
      projectDay: w.projectDay, from: w.from, until: w.until, lateUntil: w.lateUntil,
      state: now < w.from ? 'not-yet' : now <= w.until ? 'open' : now <= w.lateUntil ? 'late' : 'closed',
      submission: sub ? { githubUrl: sub.githubUrl, liveUrl: sub.liveUrl, note: sub.note, submittedAt: sub.submittedAt, late: sub.late, hasScreenshot: !!sub.screenshot?.contentType } : null,
    };
  }

  const todayClass = await classOn(s.batch, today);
  let pulseToday = null;
  if (todayClass) {
    const mine = await ClassPulse.findOne({ student: s._id, date: today }).lean();
    pulseToday = { date: today, number: todayClass.number, title: todayClass.title,
      mine: mine ? { covered: mine.covered, understanding: mine.understanding } : null };
  }

  // Own marks across cycles
  const marks = await CycleMark.find({ student: s._id }).populate('cycle', 'number assessmentHeld startDate').lean();
  const history = marks.filter(m => m.cycle).sort((a, b) => a.cycle.number - b.cycle.number).map(m => {
    const { total, outOf } = CycleMark.scoreOf(m.assessment, m.project, m.cycle.assessmentHeld !== false);
    return { cycle: m.cycle.number, status: m.status,
      project: m.project, assessment: m.cycle.assessmentHeld !== false ? m.assessment : null,
      total: m.status === 'evaluated' ? total : null, outOf, category: m.status === 'evaluated' ? m.category : '' };
  });

  // Open feedback forms for this batch
  const windows = await FeedbackWindow.find({ batches: s.batch, openFrom: { $lte: now }, openUntil: { $gte: now } }).lean();
  const feedback = [];
  for (const w of windows) {
    const given = await Feedback.find({ window: w._id, student: s._id }).select('trainer').lean();
    feedback.push({ windowId: w._id, title: w.title, until: w.openUntil,
      trainers: trainers.map(t => ({ id: t._id, name: t.name, done: given.some(g => String(g.trainer) === String(t._id)) })) });
  }

  return {
    student: { id: s._id, name: s.name, roll: s.roll, github: s.github || '', course: s.course, sem: s.sem, section: s.section },
    batch: { id: batch?._id, name: batch?.name, track: batch?.track || '', trainers: trainers.map(t => t.name) },
    today,
    attendance: { present: s.stats?.presentCount || 0, total: s.stats?.totalSessions || 0,
      pct: s.stats?.totalSessions ? Math.round(100 * s.stats.presentCount / s.stats.totalSessions) : null },
    cycle: cycleView, project, pulseToday, marks: history, feedback,
    questions: QUESTIONS.map(([key, text]) => ({ key, text })),
  };
}

// Batch-level pulse totals per date (staff view). No student names, ever.
async function pulseSummary(batchId, from, to) {
  const q = { batch: batchId };
  if (from || to) q.date = {}; if (from) q.date.$gte = from; if (to) q.date.$lte = to;
  const rows = await ClassPulse.find(q).select('date covered understanding').lean();
  const by = new Map();
  for (const r of rows) {
    const e = by.get(r.date) || { date: r.date, n: 0, yes: 0, partly: 0, no: 0, u: 0 };
    e.n++; e[r.covered]++; e.u += r.understanding; by.set(r.date, e);
  }
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date)).map(e => ({
    date: e.date, responses: e.n, yes: e.yes, partly: e.partly, no: e.no,
    coveredPct: Math.round(100 * (e.yes + e.partly / 2) / e.n),
    understanding: Math.round(10 * e.u / e.n) / 10,
  }));
}

module.exports = { todayIST, fmtIST, submitWindow, currentCycle, classOn, ratableTrainers, studentHome, pulseSummary, IST };
