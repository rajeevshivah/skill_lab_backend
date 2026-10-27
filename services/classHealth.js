// ─────────────────────────────────────────────────────────────────────
//  Class health — every planned class of every batch in a date range, with
//  what happened: the trainer's log (on time? complete?), attendance and what
//  students said (covered %, understanding), plus flags. Summed per batch and
//  over everything shown. Used by Meetings → Class health and the AI tool
//  get_class_health. A day, a week, a whole cycle — any range up to 120 days.
//
//  Per class `state`:
//    holiday · upcoming · open (today, not logged yet) · missing (past, no log)
//    no-class (admin) · done · partial · not-covered
//  `flags` (what a coordinator should look at):
//    late log · incomplete log · students disagree · low attendance (< 50%)
//    more answers than present (students not marked present answered)
// ─────────────────────────────────────────────────────────────────────
const Batch     = require('../models/Batch');
const Cycle     = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const DailyLog  = require('../models/DailyLog');
const Semester  = require('../models/Semester');
const perf      = require('./performance');
const sv        = require('./studentView');
const logRule   = require('./logRule');

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const sid = (x) => x == null ? '' : String(x._id || x);
const pct = (a, b) => b ? Math.round(100 * a / b) : null;
const LOW_ATTENDANCE = 50;

function summarise(classes) {
  const due = classes.filter(c => !['holiday', 'upcoming', 'open'].includes(c.state) && c.state !== 'no-class');
  const logged = due.filter(c => c.log);
  const att = logged.filter(c => c.attendance);
  const present = att.reduce((s, c) => s + c.attendance.present, 0), total = att.reduce((s, c) => s + c.attendance.total, 0);
  const withPulse = classes.filter(c => c.pulse);
  const answers = withPulse.reduce((s, c) => s + c.pulse.responses, 0);
  return {
    due: due.length, logged: logged.length,
    onTime: logged.filter(c => c.log.onTime).length,
    late: logged.filter(c => !c.log.onTime).length,
    incomplete: logged.filter(c => !c.log.complete).length,
    missing: due.filter(c => c.state === 'missing').length,
    done: due.filter(c => c.state === 'done').length,
    partial: due.filter(c => c.state === 'partial').length,
    notDone: due.filter(c => c.state === 'not-covered').length,
    holidays: classes.filter(c => c.state === 'holiday').length,
    attendancePct: pct(present, total), present, seats: total,
    answers,
    coveredPct: answers ? Math.round(withPulse.reduce((s, c) => s + c.pulse.coveredPct * c.pulse.responses, 0) / answers) : null,
    understanding: answers ? Math.round(10 * withPulse.reduce((s, c) => s + c.pulse.understanding * c.pulse.responses, 0) / answers) / 10 : null,
    disagree: classes.filter(c => c.flags.includes('students disagree')).length,
    flags: classes.reduce((s, c) => s + c.flags.length, 0),
  };
}

async function healthView(user, q = {}) {
  const today = sv.todayIST();
  let from = isYmd(q.from) ? q.from : today, to = isYmd(q.to) ? q.to : from;
  if (to < from) [from, to] = [to, from];
  if ((perf.ymdToDay(to) - perf.ymdToDay(from)) / 864e5 > 120) throw new Error('Pick at most 120 days.');
  const sem = await Semester.findOne({ status: 'active' }).lean();
  if (!sem) return { from, to, today, batches: [], totals: summarise([]), periods: [] };

  const bq = { semester: sem._id };
  const ids = String(q.batches || '').split(',').filter(x => /^[a-f0-9]{24}$/.test(x));
  if (ids.length) bq._id = { $in: ids };
  if (/^[a-f0-9]{24}$/.test(q.trainer || '')) bq.trainers = q.trainer;
  const [batches, allCycles, myIds] = await Promise.all([
    Batch.find(bq).select('name track trainers schedule.days').populate('trainers', 'name isActive').sort('name').lean(),
    Cycle.find({ semester: sem._id }).select('batch number startDate endDate track.projectDate track.deadline').sort('startDate').lean(),
    Batch.find({ semester: sem._id, trainers: user._id }).select('_id').lean(),
  ]);
  const mine = new Set(myIds.map(b => sid(b._id)));
  const bset = new Set(batches.map(b => sid(b._id)));
  const cycles = allCycles.filter(c => bset.has(sid(c.batch)) && perf.dayYmd(c.startDate) <= to && perf.dayYmd(c.endDate) >= from);
  const bids = batches.map(b => b._id);
  const [plans, logs, holOf, pulseOf] = await Promise.all([
    CyclePlan.find({ cycle: { $in: cycles.map(c => c._id) } }).select('cycle classes.number classes.title classes.date').lean(),
    DailyLog.find({ batch: { $in: bids }, date: { $gte: perf.ymdToDay(from), $lte: perf.ymdToDay(to) } })
      .select('batch date status planClass github notes attendance attendanceTaken createdAt completeAt loggedBy firstLoggedBy')
      .populate('firstLoggedBy', 'name').populate('loggedBy', 'name').lean(),
    sv.holidayFinder(from, to),
    sv.pulseFinder(bids.map(b => ({ batch: b, from, to }))),
  ]);
  const planOf = new Map(plans.map(p => [sid(p.cycle), p]));

  const out = batches.map(b => {
    const bc = cycles.filter(c => sid(c.batch) === sid(b._id));
    const logBy = new Map(logs.filter(l => sid(l.batch) === sid(b._id)).map(l => [perf.dayYmd(l.date), l]));
    const pulseBy = new Map(pulseOf(b._id, from, to).map(p => [p.date, p]));
    const rows = new Map();   // date → class
    for (const c of bc) {
      const cs = perf.dayYmd(c.startDate), ce = perf.dayYmd(c.endDate);
      for (const k of planOf.get(sid(c._id))?.classes || [])
        if (isYmd(k.date) && k.date >= from && k.date <= to && k.date >= cs && k.date <= ce && !rows.has(k.date))
          rows.set(k.date, { date: k.date, number: k.number, title: k.title || '', cycle: c.number, planned: true });
    }
    for (const d of logBy.keys()) if (!rows.has(d)) {
      const c = bc.find(x => perf.dayYmd(x.startDate) <= d && perf.dayYmd(x.endDate) >= d);
      rows.set(d, { date: d, number: logBy.get(d).planClass, title: '', cycle: c?.number || null, planned: false });
    }
    // holidays on the batch's class days (inside a cycle) show as their own day, even with no class planned
    const days = b.schedule?.days || [];
    for (let d = from; d <= to; d = new Date(Date.parse(d + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10)) {
      if (rows.has(d) || !days.includes(new Date(d + 'T12:00:00Z').getUTCDay()) || !holOf(b._id, d)) continue;
      const c = bc.find(x => perf.dayYmd(x.startDate) <= d && perf.dayYmd(x.endDate) >= d);
      if (c) rows.set(d, { date: d, number: null, title: '', cycle: c.number, planned: false });
    }
    const classes = [...rows.values()].sort((x, y) => x.date.localeCompare(y.date)).map(r => {
      const l = logBy.get(r.date), p = pulseBy.get(r.date), hol = holOf(b._id, r.date), flags = [];
      let state;
      if (hol && !l) state = 'holiday';
      else if (!l) state = r.date > today ? 'upcoming' : r.date === today ? 'open' : 'missing';
      else state = l.status === 'no-class' ? 'no-class' : l.status || 'done';
      let log = null, attendance = null;
      if (l && l.status !== 'no-class') {
        // same rule as the trainer score: on time = complete on the class day (before the rule: saved that day)
        const ruled = r.date >= logRule.RULE_FROM;
        const missingParts = ruled ? logRule.missingParts(l) : [];
        const savedOnDay = perf.istYmd(l.createdAt) <= r.date;
        const completedLate = ruled && !missingParts.length && l.completeAt && perf.istYmd(l.completeAt) > r.date;
        const onTime = ruled ? (!missingParts.length && !!l.completeAt && !completedLate) : savedOnDay;
        log = { status: l.status, onTime, complete: !missingParts.length, missing: missingParts,
          github: l.github || '', notes: l.notes || '', by: (l.firstLoggedBy || l.loggedBy)?.name || '', at: l.createdAt, planClass: l.planClass };
        if (!savedOnDay || completedLate) flags.push('late log');
        if (missingParts.length) flags.push('incomplete log');
        if (l.attendanceTaken || (l.attendance || []).length) {
          const present = (l.attendance || []).filter(a => a.present).length, total = (l.attendance || []).length;
          attendance = { present, total, pct: pct(present, total) };
          if (total && attendance.pct < LOW_ATTENDANCE) flags.push('low attendance');
        }
      }
      if (state === 'missing') flags.push('not logged');
      const pulse = p ? { responses: p.responses, coveredPct: p.coveredPct, understanding: p.understanding, yes: p.yes, partly: p.partly, no: p.no } : null;
      if (pulse && l && l.status === 'done' && pulse.responses >= 5 && pulse.coveredPct < 50) flags.push('students disagree');
      if (pulse && attendance && pulse.responses > attendance.present) flags.push('more answers than present');
      return { ...r, state, holiday: hol, log, attendance, pulse, flags };
    });
    return {
      batchId: b._id, batch: b.name, track: b.track || '', mine: mine.has(sid(b._id)),
      trainers: (b.trainers || []).filter(t => t.isActive !== false && !perf.isReviewer(t)).map(t => ({ id: t._id, name: t.name })),
      cycles: bc.map(c => ({ id: c._id, number: c.number, start: perf.dayYmd(c.startDate), end: perf.dayYmd(c.endDate), projectDay: perf.dayYmd(c.track?.projectDate || c.endDate) })),
      classes, summary: summarise(classes),
    };
  });

  // quick picks: each cycle period (cycles grouped by their deadline, as on Performance)
  const per = new Map();
  for (const c of allCycles) {
    const k = perf.istYmd(perf.deadlineOf(c));
    const e = per.get(k) || { key: k, start: perf.dayYmd(c.startDate), end: perf.dayYmd(c.endDate), numbers: new Set() };
    if (perf.dayYmd(c.startDate) < e.start) e.start = perf.dayYmd(c.startDate);
    if (perf.dayYmd(c.endDate) > e.end) e.end = perf.dayYmd(c.endDate);
    e.numbers.add(c.number); per.set(k, e);
  }
  const periods = [...per.values()].sort((a, b) => a.start.localeCompare(b.start)).map(e => ({ key: e.key, start: e.start, end: e.end, numbers: [...e.numbers].sort((a, b) => a - b) }));

  return { from, to, today, batches: out, totals: summarise(out.flatMap(b => b.classes)), periods };
}

module.exports = { healthView, summarise };
