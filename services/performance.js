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
//  Anything done by an admin gives the trainer 0 for that part — except the cycle plan:
//  a plan the admin made is not counted at all (planning can be done by either side).
//
//  Who is scored for what (batches with several trainers):
//    lead          — one trainer per cycle (default: the batch's first trainer)
//    owners.report/marks/top3/plan — who must do each task (default: the lead)
//    daily logs    — each class day belongs to the trainer planned for it in the
//                    cycle plan; if none is planned, to the trainer who logged it;
//                    a day nobody (or only an admin) logged with no planned
//                    trainer counts for every trainer of the batch
//    outcomes      — shared by all trainers of the batch
//    waits         — an owner can say "waiting on <trainer>"; once the admin
//                    approves it, lateness after that moment moves to that trainer
// ─────────────────────────────────────────────────────────────────────
const Batch     = require('../models/Batch');
const Student   = require('../models/Student');
const CycleMark = require('../models/CycleMark');
const CyclePlan = require('../models/CyclePlan');
const DailyLog  = require('../models/DailyLog');
const Holiday   = require('../models/Holiday');
const logRule = require('./logRule');   // logRule.RULE_FROM read at call time (tests override it)
const { isComplete } = logRule;

const DAY = 24 * 3600 * 1000;
const IST = 330 * 60 * 1000;
const WEIGHTS = { logs: 35, report: 10, marks: 10, top3: 10, plan: 15, attendance: 10, outcomes: 10 };

const pad = (n) => String(n).padStart(2, '0');
const isReviewer = (u) => /\(review\)/i.test(u?.name || '');
const sid = (x) => x == null ? '' : String(x._id || x);
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

// Credit for one class day's log
const DAY_CREDIT = { 'on-time': 1, late: 0.5, incomplete: 0.5, 'incomplete-late': 0.25 };
const dayCredit = (x) => DAY_CREDIT[x.state] || 0;
const dayCounts = (list) => ({
  onTime: list.filter(x => x.state === 'on-time').length,
  late: list.filter(x => x.state === 'late').length,
  incomplete: list.filter(x => x.state === 'incomplete' || x.state === 'incomplete-late').length,
  admin: list.filter(x => x.state === 'admin').length,
  missing: list.filter(x => x.state === 'missing').length,
});

// Everything scoring needs for MANY cycles, loaded in one round of parallel
// queries (not ~6 queries per cycle one after another — that made the
// Performance and Meeting pages take a minute on a far-away database).
async function loadScoreData(cycles) {
  const list = cycles.filter(Boolean);
  const ids = list.map(c => c._id);
  const batchIds = [...new Set(list.map(c => sid(c.batch)))];
  const semIds = [...new Set(list.map(c => sid(c.semester)).filter(Boolean))];
  const marked = list.filter(c => c.track?.marks?.at).map(c => c._id);
  const ranges = list.map(c => ({ batch: c.batch._id || c.batch, date: { $gte: c.startDate, $lte: c.endDate } }));
  const [logs, plans, batches, hols, marks] = await Promise.all([
    ranges.length ? DailyLog.find({ $or: ranges })
      .select('batch date createdAt loggedBy firstLoggedBy attendanceTaken status planClass github notes completeAt').lean() : [],
    CyclePlan.find({ cycle: { $in: ids } }).select('cycle classes.date classes.trainer').lean(),
    Batch.find({ _id: { $in: batchIds } }).select('trainers').populate('trainers', 'name isActive').lean(),
    semIds.length ? Holiday.find({ semester: { $in: semIds } }).select('semester batches from to').lean() : [],
    marked.length ? CycleMark.find({ cycle: { $in: marked }, status: 'evaluated' }).select('cycle category').lean() : [],
  ]);
  const group = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
  return {
    logsByBatch: group(logs, l => sid(l.batch)),
    planByCycle: new Map(plans.map(p => [sid(p.cycle), p])),
    batchById: new Map(batches.map(b => [sid(b._id), b])),
    hols, marksByCycle: group(marks, m => sid(m.cycle)),
  };
}

// Scores for many cycles → Map(cycleId → score). Same rules as scoreCycle.
async function scoreCycles(cycles, now = new Date()) {
  const data = await loadScoreData(cycles);
  return new Map(cycles.filter(Boolean).map(c => [sid(c._id), scoreWith(c, data, now)]));
}

async function scoreCycle(cycle, now = new Date()) {
  return scoreWith(cycle, await loadScoreData([cycle]), now);
}

function scoreWith(cycle, data, now) {
  const deadline = deadlineOf(cycle);
  const excused = !!cycle.track?.excusedNote;
  const t = cycle.track || {};
  const items = {
    report: deadlineItem(t.report, deadline, now, excused, WEIGHTS.report),
    marks:  deadlineItem(t.marks,  deadline, now, excused, WEIGHTS.marks),
    top3:   deadlineItem(t.top3,   deadline, now, excused, WEIGHTS.top3),
  };

  // Tracking only counts from the day it began: earlier class days are ignored,
  // and the plan can't be due before tracking started (+2 days to fill it).
  const from = t.trackedFrom || (t.tracked ? cycle.createdAt : null);
  const fromYmd = from ? istYmd(from) : null;
  // Cycle plan — should exist before the cycle starts
  const startYmd = dayYmd(cycle.startDate);
  const afterFrom = fromYmd ? istYmd(new Date(from).getTime() + 2 * DAY) : null;
  const planDueYmd = afterFrom && afterFrom > startYmd ? afterFrom : startYmd;
  if (t.plan?.at) {
    // Plans are a two-way job: the admin may design the plan himself. An admin-made plan is
    // shown as such but NOT counted — the trainer is neither credited nor penalised.
    if (t.plan.admin) items.plan = { state: 'admin-planned', points: 0, max: 0, at: t.plan.at };
    else {
      const lateDays = Math.max(0, (ymdToDay(istYmd(t.plan.at)) - ymdToDay(planDueYmd)) / DAY);
      items.plan = lateDays === 0 ? { state: 'on-time', points: 15, max: 15, at: t.plan.at }
        : { state: 'late', points: lateDays <= 3 ? 8 : 4, max: 15, at: t.plan.at, lateDays };
    }
  } else if (planDueYmd === startYmd ? istYmd(now) < startYmd : istYmd(now) <= planDueYmd) items.plan = { state: 'pending', points: 0, max: 0, dueBy: planDueYmd };
  else items.plan = { state: 'missing', points: 0, max: WEIGHTS.plan };

  // Daily logs + attendance — every class day so far in the cycle
  const today = istYmd(now);
  const lastDay = dayYmd(cycle.endDate) < today ? dayYmd(cycle.endDate) : today;
  const bId = sid(cycle.batch);
  const cs = new Date(cycle.startDate), ce = new Date(cycle.endDate);
  const logs = (data.logsByBatch.get(bId) || []).filter(l => new Date(l.date) >= cs && new Date(l.date) <= ce);
  const plan = data.planByCycle.get(sid(cycle._id)) || null;
  const batch = data.batchById.get(bId) || null;
  const isTrainer = (u) => (batch?.trainers || []).some(x => sid(x) === sid(u));
  const eligible = (batch?.trainers || []).filter(x => x.isActive !== false && !isReviewer(x));
  const isEligible = (u) => eligible.some(x => sid(x) === sid(u));
  const plannedBy = new Map();
  for (const c of plan?.classes || []) if (c.date && c.trainer) plannedBy.set(c.date, sid(c.trainer));
  const byDay = new Map(logs.map(l => [dayYmd(l.date), l]));
  const days = new Set([...byDay.keys()]);
  for (const c of plan?.classes || []) if (c.date && c.date >= startYmd && c.date <= lastDay) days.add(c.date);
  // Holidays (Settings → Holidays) are never class days for anyone
  const endYmd = dayYmd(cycle.endDate);
  const hols = data.hols.filter(h => sid(h.semester) === sid(cycle.semester)
    && (!(h.batches || []).length || h.batches.some(x => sid(x) === bId))
    && h.from <= endYmd && h.to >= startYmd);
  const isHol = (d) => hols.some(h => d >= h.from && d <= h.to);
  const logDays = [], noClassDays = [];
  for (const d of [...days].sort()) {
    if (d > lastDay || (fromYmd && d < fromYmd)) continue;
    if (isHol(d)) { noClassDays.push(d); continue; }
    const l = byDay.get(d);
    const planned = plannedBy.has(d) && isEligible(plannedBy.get(d)) ? plannedBy.get(d) : null;
    if (!l) { if (d === today) continue; logDays.push({ date: d, state: 'missing', resp: planned || '*' }); continue; }
    if (l.status === 'no-class') { noClassDays.push(d); continue; }   // holiday / cancelled (admin)
    const who = l.firstLoggedBy || l.loggedBy;
    let state;
    if (!isTrainer(who)) state = 'admin';
    else if (d < logRule.RULE_FROM) state = istYmd(l.createdAt) <= d ? 'on-time' : 'late';
    else if (isComplete(l) && l.completeAt) state = istYmd(l.completeAt) <= d ? 'on-time' : 'late';
    else if (d === today) continue;                       // still time today to complete it
    else state = istYmd(l.createdAt) <= d ? 'incomplete' : 'incomplete-late';
    logDays.push({ date: d, state, attendance: !!l.attendanceTaken && state !== 'admin',
      resp: planned || (isEligible(who) ? sid(who) : '*') });
  }
  if (logDays.length) {
    const n = logDays.length;
    const lp = logDays.reduce((s, x) => s + dayCredit(x), 0);
    const ap = logDays.filter(x => x.attendance).length;
    items.logs = { state: 'counted', points: WEIGHTS.logs * lp / n, max: WEIGHTS.logs,
      days: n, ...dayCounts(logDays), noClass: noClassDays.length };
    items.attendance = { state: 'counted', points: WEIGHTS.attendance * ap / n, max: WEIGHTS.attendance, taken: ap, days: n };
  } else {
    items.logs = { state: 'pending', points: 0, max: 0, days: 0 };
    items.attendance = { state: 'pending', points: 0, max: 0, days: 0 };
  }

  // Student outcomes — share of evaluated students at Moderate or above
  if (t.marks?.at) {
    const marks = data.marksByCycle.get(sid(cycle._id)) || [];
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

  // ── Per-trainer scores (who is responsible for what) ──
  const lead = eligible.find(x => sid(x) === sid(t.lead)) || eligible[0] || null;
  const owners = {};
  for (const k of ['report', 'marks', 'top3', 'plan'])
    owners[k] = eligible.find(x => sid(x) === sid(t.owners?.[k])) || lead;
  const approved = (t.waits || []).filter(w => w.status === 'approved');
  const perTrainer = eligible.map(tr => {
    const me = sid(tr), mine = {};
    for (const k of ['report', 'marks', 'top3']) {
      const base = items[k], w = approved.filter(x => x.item === k).sort((a, b) => a.raisedAt - b.raisedAt)[0];
      if (owners[k] && sid(owners[k]) === me) {
        if (w && (!base.at || w.raisedAt < base.at)) {
          // owner did their part by the time they flagged the wait
          mine[k] = { ...deadlineItem({ at: w.raisedAt, admin: false }, deadline, now, excused, WEIGHTS[k]), waitedOn: true };
        } else mine[k] = base;
      } else if (w && sid(w.waitingOn) === me) {
        // the trainer who held things up carries the lateness (only if it was late)
        const it = deadlineItem({ at: base.at || null, admin: false }, deadline, now, excused, WEIGHTS[k]);
        if (it.state === 'late' || it.state === 'missing') mine[k] = { ...it, blocking: true };
      }
    }
    if (owners.plan && sid(owners.plan) === me) mine.plan = items.plan;
    const days = logDays.filter(x => x.resp === me || x.resp === '*');
    if (days.length) {
      const n = days.length;
      const lp = days.reduce((a, x) => a + dayCredit(x), 0);
      mine.logs = { state: 'counted', points: WEIGHTS.logs * lp / n, max: WEIGHTS.logs, days: n, ...dayCounts(days) };
      const ap = days.filter(x => x.attendance).length;
      mine.attendance = { state: 'counted', points: WEIGHTS.attendance * ap / n, max: WEIGHTS.attendance, taken: ap, days: n };
    }
    mine.outcomes = items.outcomes;
    const mx = Object.values(mine).reduce((a, i) => a + i.max, 0);
    const pt = Object.values(mine).reduce((a, i) => a + i.points, 0);
    return { id: sid(tr), name: tr.name, isLead: !!lead && sid(lead) === me,
      owns: Object.keys(owners).filter(k => owners[k] && sid(owners[k]) === me),
      items: mine, score: mx ? Math.round(pt / mx * 100) : null };
  });

  return {
    lead: lead ? { id: sid(lead), name: lead.name } : null,
    owners: Object.fromEntries(Object.entries(owners).map(([k, v]) => [k, v ? { id: sid(v), name: v.name } : null])),
    perTrainer,
    trackedFrom: from || null, planDue: planDueYmd,
    deadline, projectDate: projectDayOf(cycle), excusedNote: t.excusedNote || '',
    tracked: !!t.tracked, items, overall, completedAt,
    lateBy: completedAt && completedAt > deadline ? Math.round((completedAt - deadline) / DAY * 10) / 10 : 0,
    lateEdits: (t.lateEdits || []).length,
    score: max ? Math.round(pts / max * 100) : null,
  };
}

module.exports = { isReviewer, sid, WEIGHTS, defaultDeadline, deadlineOf, projectDayOf, stamp, marksComplete, scoreCycle, scoreCycles, dayYmd, istYmd, ymdToDay, istToDate };
