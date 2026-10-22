// ─────────────────────────────────────────────────────────────────────
//  Trainer accountability: deadlines, who-did-what stamps, and the score.
//
//  Each cycle carries cycle.track:
//    tracked      — only tracked cycles are scored (Cycle 1–3 were not)
//    projectDate  — the batch's project / evaluation day
//    deadline     — when report + marks + Top 3 are due
//                   (default: the Saturday after the project day, 7 PM IST)
//    excusedNote  — admin note; lateness in this cycle is not penalised
//    report / marks / top3 / plan — FIRST completion: { at, by, admin }
//                   admin=true → done by someone who is not a trainer of the batch
//    lateEdits    — changes made after the deadline (kept for transparency)
//
//  Score (out of 100, only over the parts that are already due):
//    daily log same day 35 · report+marks+Top3 on time 30 (10 each)
//    cycle plan before start 15 · attendance taken 10 · student outcomes 10
//  Anything done by an admin gives the trainer 0 for that part.
// ─────────────────────────────────────────────────────────────────────
const Batch     = require('../models/Batch');
const Student   = require('../models/Student');
const CycleMark = require('../models/CycleMark');
const CyclePlan = require('../models/CyclePlan');
const DailyLog  = require('../models/DailyLog');

const DAY = 24 * 3600 * 1000;
const IST = 330 * 60 * 1000;
const WEIGHTS = { logs: 35, report: 10, marks: 10, top3: 10, plan: 15, attendance: 10, outcomes: 10 };

const pad = (n) => String(n).padStart(2, '0');
// calendar day of a stored "day" date (stored at server-local midnight)
const dayYmd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
// calendar day in India of a real timestamp
const istYmd = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
// 'YYYY-MM-DD' → stored day date (server-local midnight, same as the cycle/log routes)
const ymdToDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
// 'YYYY-MM-DDTHH:mm' in India time → Date
const istToDate = (s) => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 19), +(m[5] || 0)) - IST);
};

// Saturday after the project day, 7 PM India time
function defaultDeadline(projectDay) {
  const [y, m, d] = dayYmd(projectDay).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();       // 0 Sun … 6 Sat
  let add = (6 - wd + 7) % 7; if (add === 0) add = 7;
  return new Date(Date.UTC(y, m - 1, d + add, 19, 0) - IST);
}
const projectDayOf = (c) => c.track?.projectDate || c.endDate;
const deadlineOf   = (c) => c.track?.deadline || defaultDeadline(projectDayOf(c));

async function isAdminActor(user, batchId) {
  const b = await Batch.findById(batchId).select('trainers');
  return !(b?.trainers || []).some(t => String(t) === String(user._id));
}

// Record who first completed `item` (and when). Later changes after the
// deadline are kept as lateEdits. Caller saves the cycle.
async function stamp(cycle, item, user) {
  if (!cycle.track) cycle.track = {};
  const admin = await isAdminActor(user, cycle.batch);
  const now = new Date();
  if (!cycle.track[item] || !cycle.track[item].at) {
    cycle.track[item] = { at: now, by: user._id, admin };
  } else if (now > deadlineOf(cycle)) {
    cycle.track.lateEdits = [...(cycle.track.lateEdits || []), { item, at: now, by: user._id, admin }].slice(-30);
  }
  cycle.markModified('track');
}

// Marks count as complete when every student of the batch has an entry
// (evaluated or not-evaluated) for this cycle.
async function marksComplete(cycle) {
  const [students, marks] = await Promise.all([
    Student.countDocuments({ batch: cycle.batch }),
    CycleMark.countDocuments({ cycle: cycle._id }),
  ]);
  return students > 0 && marks >= students;
}

// One deadline item → { state, points, max, at, admin }
function deadlineItem(st, deadline, now, excused, max) {
  if (st?.at) {
    if (st.admin) return { state: 'admin', points: 0, max, at: st.at };
    if (st.at <= deadline || excused) return { state: excused && st.at > deadline ? 'excused' : 'on-time', points: max, max, at: st.at };
    const lateDays = (st.at - deadline) / DAY;
    return { state: 'late', points: lateDays <= 2 ? max / 2 : max / 5, max, at: st.at, lateDays: Math.round(lateDays * 10) / 10 };
  }
  if (now <= deadline) return { state: 'pending', points: 0, max: 0 };
  if (excused) return { state: 'excused', points: 0, max: 0 };
  return { state: 'missing', points: 0, max };
}

async function scoreCycle(cycle, now = new Date()) {
  const deadline = deadlineOf(cycle);
  const excused = !!cycle.track?.excusedNote;
  const t = cycle.track || {};
  const items = {
    report: deadlineItem(t.report, deadline, now, excused, WEIGHTS.report),
    marks:  deadlineItem(t.marks,  deadline, now, excused, WEIGHTS.marks),
    top3:   deadlineItem(t.top3,   deadline, now, excused, WEIGHTS.top3),
  };

  // Cycle plan — should exist before the cycle starts
  const startYmd = dayYmd(cycle.startDate);
  if (t.plan?.at) {
    if (t.plan.admin) items.plan = { state: 'admin', points: 0, max: WEIGHTS.plan, at: t.plan.at };
    else {
      const lateDays = Math.max(0, (ymdToDay(istYmd(t.plan.at)) - ymdToDay(startYmd)) / DAY);
      items.plan = lateDays === 0 ? { state: 'on-time', points: 15, max: 15, at: t.plan.at }
        : { state: 'late', points: lateDays <= 3 ? 8 : 4, max: 15, at: t.plan.at, lateDays };
    }
  } else if (istYmd(now) < startYmd) items.plan = { state: 'pending', points: 0, max: 0 };
  else items.plan = { state: 'missing', points: 0, max: WEIGHTS.plan };

  // Daily logs + attendance — every class day so far in the cycle
  const today = istYmd(now);
  const lastDay = dayYmd(cycle.endDate) < today ? dayYmd(cycle.endDate) : today;
  const [logs, plan] = await Promise.all([
    DailyLog.find({ batch: cycle.batch, date: { $gte: cycle.startDate, $lte: cycle.endDate } })
      .select('date createdAt loggedBy firstLoggedBy attendanceTaken').lean(),
    CyclePlan.findOne({ cycle: cycle._id }).select('classes.date').lean(),
  ]);
  const batch = await Batch.findById(cycle.batch).select('trainers').lean();
  const isTrainer = (u) => (batch?.trainers || []).some(x => String(x) === String(u));
  const byDay = new Map(logs.map(l => [dayYmd(l.date), l]));
  const days = new Set([...byDay.keys()]);
  for (const c of plan?.classes || []) if (c.date && c.date >= startYmd && c.date <= lastDay) days.add(c.date);
  const logDays = [];
  for (const d of [...days].sort()) {
    if (d > lastDay) continue;
    const l = byDay.get(d);
    if (!l) { if (d === today) continue; logDays.push({ date: d, state: 'missing' }); continue; }
    const who = l.firstLoggedBy || l.loggedBy;
    const state = !isTrainer(who) ? 'admin' : istYmd(l.createdAt) <= d ? 'on-time' : 'late';
    logDays.push({ date: d, state, attendance: !!l.attendanceTaken && state !== 'admin' });
  }
  if (logDays.length) {
    const n = logDays.length;
    const lp = logDays.reduce((s, x) => s + (x.state === 'on-time' ? 1 : x.state === 'late' ? 0.5 : 0), 0);
    const ap = logDays.filter(x => x.attendance).length;
    items.logs = { state: 'counted', points: WEIGHTS.logs * lp / n, max: WEIGHTS.logs,
      days: n, onTime: logDays.filter(x => x.state === 'on-time').length,
      late: logDays.filter(x => x.state === 'late').length,
      admin: logDays.filter(x => x.state === 'admin').length,
      missing: logDays.filter(x => x.state === 'missing').length };
    items.attendance = { state: 'counted', points: WEIGHTS.attendance * ap / n, max: WEIGHTS.attendance, taken: ap, days: n };
  } else {
    items.logs = { state: 'pending', points: 0, max: 0, days: 0 };
    items.attendance = { state: 'pending', points: 0, max: 0, days: 0 };
  }

  // Student outcomes — share of evaluated students at Moderate or above
  if (t.marks?.at) {
    const marks = await CycleMark.find({ cycle: cycle._id, status: 'evaluated' }).select('category').lean();
    const good = marks.filter(m => m.category === 'excellent' || m.category === 'moderate').length;
    items.outcomes = marks.length
      ? { state: 'counted', points: WEIGHTS.outcomes * good / marks.length, max: WEIGHTS.outcomes, good, evaluated: marks.length }
      : { state: 'pending', points: 0, max: 0 };
  } else items.outcomes = { state: 'pending', points: 0, max: 0 };

  const max = Object.values(items).reduce((s, i) => s + i.max, 0);
  const pts = Object.values(items).reduce((s, i) => s + i.points, 0);

  // Overall status of the cycle-end work (report + marks + Top 3)
  const trio = [items.report, items.marks, items.top3];
  let overall;
  if (trio.some(i => i.state === 'missing')) overall = 'missing';
  else if (trio.some(i => i.state === 'pending')) overall = 'pending';
  else if (trio.some(i => i.state === 'admin')) overall = 'admin';
  else if (trio.some(i => i.state === 'late')) overall = 'late';
  else overall = trio.some(i => i.state === 'excused') ? 'excused' : 'on-time';
  const completedAt = trio.every(i => i.at) ? new Date(Math.max(...trio.map(i => +i.at))) : null;

  return {
    deadline, projectDate: projectDayOf(cycle), excusedNote: t.excusedNote || '',
    tracked: !!t.tracked, items, overall, completedAt,
    lateBy: completedAt && completedAt > deadline ? Math.round((completedAt - deadline) / DAY * 10) / 10 : 0,
    lateEdits: (t.lateEdits || []).length,
    score: max ? Math.round(pts / max * 100) : null,
  };
}

module.exports = { WEIGHTS, defaultDeadline, deadlineOf, stamp, marksComplete, scoreCycle, dayYmd, istYmd, ymdToDay, istToDate };
