// ─────────────────────────────────────────────────────────────────────
//  Batch timetables + holidays.
//
//  Timetable: Batch.schedule.days (weekdays 0 Sun … 6 Sat). If not set, a
//  guess is made from the dates in the batch's class plans and logs.
//
//  Holiday: a day or range for all batches or chosen ones.
//    mode 'shift' — every planned class from the first holiday day onward is
//      moved to the batch's next class day (order kept, gaps kept). If classes
//      go past the cycle end, the end date moves too; the project day moves
//      with the project class; an explicitly set deadline moves to the
//      Saturday after the new project day. Refused if that would run into the
//      batch's next cycle. Classes already held (a log exists) never move.
//    mode 'mark'  — nothing moves; classes on those days are flagged for re-planning.
//  Either way holiday days are not counted for logs/scores, students get no
//  "did we cover it?" question, and the board shows the holiday.
//  Removing a holiday undoes its moves (only where nobody changed them since).
// ─────────────────────────────────────────────────────────────────────
const Batch     = require('../models/Batch');
const Cycle     = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const DailyLog  = require('../models/DailyLog');
const Holiday   = require('../models/Holiday');
const perf      = require('./performance');

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const wd = (ymd) => new Date(ymd + 'T12:00:00Z').getUTCDay();
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T12:00:00Z'));
function rangeDays(from, to) { const out = []; for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d); return out; }

// Guess a batch's class weekdays from its planned and logged dates.
async function inferDays(batchId) {
  const plans = await CyclePlan.find({ batch: batchId }).select('classes.date').lean();
  const logs = await DailyLog.find({ batch: batchId }).sort('-date').limit(60).select('date status').lean();
  const count = [0, 0, 0, 0, 0, 0, 0];
  for (const p of plans) for (const k of p.classes || []) if (isYmd(k.date)) count[wd(k.date)]++;
  for (const l of logs) if (l.status !== 'no-class') count[new Date(l.date).getDay()]++;
  const max = Math.max(...count);
  if (!max) return [];
  return count.map((c, i) => (i !== 0 && c >= Math.max(1, Math.ceil(max * 0.25))) ? i : -1).filter(i => i >= 0);
}
async function batchDays(batch) {
  const days = batch.schedule?.days || [];
  if (days.length) return { days: [...days].sort(), source: 'saved' };
  return { days: await inferDays(batch._id), source: 'guessed' };
}

// ymd → title for every holiday day that applies to this batch
async function holidayMap(batchId, semesterId, { excludeId = null } = {}) {
  const q = { $or: [{ batches: { $size: 0 } }, { batches: batchId }] };
  if (semesterId) q.semester = semesterId;
  if (excludeId) q._id = { $ne: excludeId };
  const hs = await Holiday.find(q).lean();
  const m = new Map();
  for (const h of hs) for (const d of rangeDays(h.from, h.to)) m.set(d, h.title);
  return m;
}

// What marking this holiday would change. Nothing is saved.
async function preview({ from, to, title, batchIds, mode }, semester, { excludeId = null } = {}) {
  if (!isYmd(from)) throw new Error('Pick the first holiday date.');
  to = isYmd(to) ? to : from;
  if (to < from) throw new Error('The last day must be on or after the first day.');
  if (rangeDays(from, to).length > 31) throw new Error('A holiday can be at most 31 days long.');
  const all = await Batch.find({ semester: semester._id, ...(batchIds?.length ? { _id: { $in: batchIds } } : {}) }).lean();
  const range = new Set(rangeDays(from, to));
  const out = [];
  for (const b of all.sort((x, y) => x.name.localeCompare(y.name))) {
    const { days, source } = await batchDays(b);
    const hol = await holidayMap(b._id, semester._id, { excludeId });
    for (const d of range) hol.set(d, title || 'Holiday');
    const cycles = await Cycle.find({ batch: b._id }).sort('startDate').lean();
    const row = { batchId: b._id, batch: b.name, days: days.map(d => WD[d]), dayNums: days, source, moves: [], onHoliday: [], cycleChanges: [], conflict: null, note: '' };
    const logs = await DailyLog.find({ batch: b._id, date: { $gte: perf.ymdToDay(from) } }).select('date status').lean();
    const held = new Set(logs.filter(l => l.status !== 'no-class').map(l => perf.dayYmd(l.date)));
    for (let ci = 0; ci < cycles.length; ci++) {
      const c = cycles[ci];
      const plan = await CyclePlan.findOne({ cycle: c._id }).lean();
      const later = (plan?.classes || []).filter(k => isYmd(k.date) && k.date >= from && !held.has(k.date))
        .sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number);
      if (!later.length) continue;
      if (mode !== 'mark' && days.length && source !== 'saved') {
        row.conflict = `Class days for ${b.name} are only guessed (${days.map(d => WD[d]).join(', ')}). Confirm them in Settings → Batch timetables first, so classes move to the right days.`;
        break;
      }
      if (mode === 'mark' || !days.length) {
        for (const k of later) if (range.has(k.date)) row.onHoliday.push({ cycleId: c._id, cycle: c.number, number: k.number, title: k.title, date: k.date });
        if (mode !== 'mark' && !days.length && row.onHoliday.length) row.note = 'No timetable set for this batch — set it in Settings so classes can be moved.';
        continue;
      }
      let prev = null; const moves = [];
      for (const k of later) {
        let t = prev && addDays(prev, 1) > k.date ? addDays(prev, 1) : k.date;
        let guard = 0;
        while ((!days.includes(wd(t)) || hol.has(t)) && guard++ < 120) t = addDays(t, 1);
        if (t !== k.date) moves.push({ cycleId: c._id, cycle: c.number, number: k.number, title: k.title, from: k.date, to: t });
        prev = t;
      }
      if (!moves.length) continue;
      row.moves.push(...moves);
      // cycle end / project day / deadline
      const endYmd = perf.dayYmd(c.endDate);
      const newDates = (plan.classes || []).map(k => moves.find(m => m.number === k.number)?.to || k.date).filter(isYmd);
      const lastNew = newDates.sort().pop();
      const ch = { cycleId: c._id, cycle: c.number };
      if (lastNew > endYmd) { ch.endFrom = endYmd; ch.endTo = lastNew; }
      const pd = c.track?.projectDate ? perf.dayYmd(c.track.projectDate) : null;
      const pMove = pd && moves.find(m => m.from === pd);
      if (pMove) { ch.projectFrom = pd; ch.projectTo = pMove.to; }
      const newProject = ch.projectTo || (pd ? null : ch.endTo);
      if (newProject && c.track?.deadline) {
        const nd = perf.defaultDeadline(perf.ymdToDay(newProject));
        if (nd > new Date(c.track.deadline)) { ch.deadlineFrom = c.track.deadline; ch.deadlineTo = nd; }
      }
      if (ch.endTo || ch.projectTo || ch.deadlineTo) row.cycleChanges.push(ch);
      const next = cycles[ci + 1];
      if (ch.endTo && next && perf.dayYmd(next.startDate) <= ch.endTo)
        row.conflict = `Cycle ${c.number} would run to ${ch.endTo}, into Cycle ${next.number} (starts ${perf.dayYmd(next.startDate)}). Use "mark only" and re-plan by hand.`;
    }
    out.push(row);
  }
  return { from, to, title: title || 'Holiday', mode: mode === 'mark' ? 'mark' : 'shift', batches: out, ok: !out.some(r => r.conflict) };
}

async function writePlanDates(user, cycleId, changes, text) {
  const plan = await CyclePlan.findOne({ cycle: cycleId });
  if (!plan) return;
  for (const k of plan.classes) { const m = changes.find(x => x.number === k.number && x.from === k.date); if (m) k.date = m.to; }
  plan.changes = [...(plan.changes || []), { at: new Date(), by: user._id, text }].slice(-60);
  plan.updatedBy = user._id;
  await plan.save();
}

async function apply(input, semester, user) {
  const p = await preview(input, semester);
  if (!p.ok) throw new Error(p.batches.find(b => b.conflict).conflict);
  const h = new Holiday({ semester: semester._id, from: p.from, to: p.to, title: p.title,
    batches: input.batchIds?.length ? input.batchIds : [], mode: p.mode, createdBy: user._id, moves: [], cycleChanges: [] });
  const label = `${p.title} (${p.from}${p.to !== p.from ? ' – ' + p.to : ''})`;
  for (const r of p.batches) {
    const byCycle = new Map();
    for (const m of r.moves) { const k = String(m.cycleId); if (!byCycle.has(k)) byCycle.set(k, []); byCycle.get(k).push(m); }
    for (const [cid, ms] of byCycle) {
      await writePlanDates(user, cid, ms, `Holiday ${label}: ${ms.map(m => `class ${m.number} ${m.from} → ${m.to}`).join('; ')}`.slice(0, 400));
      for (const m of ms) h.moves.push({ cycle: cid, batch: r.batchId, number: m.number, from: m.from, to: m.to });
    }
    for (const ch of r.cycleChanges) {
      const c = await Cycle.findById(ch.cycleId);
      const rec = { cycle: c._id };
      if (ch.endTo) { rec.endFrom = c.endDate; c.endDate = perf.ymdToDay(ch.endTo); rec.endTo = c.endDate; }
      if (ch.projectTo) { rec.projectFrom = c.track.projectDate; c.track.projectDate = perf.ymdToDay(ch.projectTo); rec.projectTo = c.track.projectDate; }
      if (ch.deadlineTo) { rec.deadlineFrom = c.track.deadline; c.track.deadline = ch.deadlineTo; rec.deadlineTo = ch.deadlineTo; }
      c.markModified('track'); await c.save();
      h.cycleChanges.push(rec);
    }
  }
  await h.save();
  return { holiday: h, preview: p };
}

// Remove a holiday and put back what it moved (where nothing changed since).
async function remove(id, user) {
  const h = await Holiday.findById(id);
  if (!h) throw new Error('Holiday not found');
  const skipped = [];
  const byCycle = new Map();
  for (const m of h.moves) { const k = String(m.cycle); if (!byCycle.has(k)) byCycle.set(k, []); byCycle.get(k).push({ number: m.number, from: m.to, to: m.from }); }
  for (const [cid, ms] of byCycle) {
    const plan = await CyclePlan.findOne({ cycle: cid }).lean();
    const ok = ms.filter(m => (plan?.classes || []).some(k => k.number === m.number && k.date === m.from));
    skipped.push(...ms.filter(m => !ok.includes(m)).map(m => `class ${m.number} (changed since)`));
    if (ok.length) await writePlanDates(user, cid, ok, `Holiday removed (${h.title}): ${ok.map(m => `class ${m.number} back to ${m.to}`).join('; ')}`.slice(0, 400));
  }
  for (const r of h.cycleChanges) {
    const c = await Cycle.findById(r.cycle); if (!c) continue;
    if (r.endTo && +c.endDate === +r.endTo) c.endDate = r.endFrom; else if (r.endTo) skipped.push(`Cycle ${c.number} end date (changed since)`);
    if (r.projectTo && +new Date(c.track?.projectDate) === +r.projectTo) c.track.projectDate = r.projectFrom;
    if (r.deadlineTo && +new Date(c.track?.deadline) === +r.deadlineTo) c.track.deadline = r.deadlineFrom;
    c.markModified('track'); await c.save();
  }
  await Holiday.deleteOne({ _id: h._id });
  return { skipped };
}

module.exports = { WD, wd, addDays, rangeDays, inferDays, batchDays, holidayMap, preview, apply, remove };
