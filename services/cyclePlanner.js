// ─────────────────────────────────────────────────────────────────────
//  The cycle planner — the ONE way cycles are created (calendar page and the
//  plan_cycles AI tool both call this).
//
//  Input:  groups   [{ name, batchIds[], start, end, projectDay?, projectDays?{batchId: ymd} }]
//          holidays [{ from, to, title, batchIds[] (empty = all batches) }]
//  For every batch it works out: the next cycle number, the class days
//  (confirmed weekly timetable minus holidays — saved ones AND the new ones),
//  the project day (given, or the last class day), and dated EMPTY plan rows
//  numbered on from the batch's last class number. Trainers then only type
//  topics. Problems that would break things later are errors (block create);
//  things worth a look are warnings.
//
//  create(): marks the new holidays ("mark" mode — nothing in existing plans
//  moves; classes on them are flagged), creates the cycles (tracked from now,
//  project day set) and their dated rows through the plan store.
// ─────────────────────────────────────────────────────────────────────
const Batch     = require('../models/Batch');
const Cycle     = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const cal       = require('./calendar');
const perf      = require('./performance');
const planStore = require('./planStore');

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T12:00:00Z'));

async function nextClassNumber(batchId) {
  const plans = await CyclePlan.find({ batch: batchId }).select('classes.number').lean();
  let max = 0;
  for (const p of plans) for (const k of p.classes || []) if (k.number > max) max = k.number;
  return max + 1;
}

async function preview({ groups = [], holidays = [] }, semester) {
  const errors = [];
  const drafts = holidays.filter(h => isYmd(h.from)).map(h => ({ from: h.from, to: isYmd(h.to) && h.to >= h.from ? h.to : h.from,
    title: String(h.title || 'Holiday').slice(0, 80), batchIds: (h.batchIds || []).map(String) }));
  const seen = new Map();
  const rows = [];
  for (const [gi, g] of groups.entries()) {
    const gname = g.name || `Group ${gi + 1}`;
    if (!isYmd(g.start) || !isYmd(g.end)) { errors.push(`${gname}: pick a start and an end date.`); continue; }
    if (g.end < g.start) { errors.push(`${gname}: the end date is before the start date.`); continue; }
    if (!(g.batchIds || []).length) { errors.push(`${gname}: choose at least one batch.`); continue; }
    for (const id of g.batchIds) {
      const b = await Batch.findOne({ _id: id, semester: semester._id }).lean();
      if (!b) { errors.push(`${gname}: a batch was not found in the active semester.`); continue; }
      const row = { batchId: b._id, batch: b.name, group: gname, start: g.start, end: g.end, errors: [], warnings: [] };
      rows.push(row);
      if (seen.has(String(b._id))) { row.errors.push(`Also in ${seen.get(String(b._id))} — a batch can be in one group only.`); continue; }
      seen.set(String(b._id), gname);

      const t = await cal.batchDays(b);
      row.days = t.days.map(d => cal.WD[d]);
      if (!t.days.length) { row.errors.push('No class days set — set this batch\'s timetable in Settings.'); continue; }
      if (t.source !== 'saved') { row.errors.push(`Class days only guessed (${row.days.join(', ')}) — confirm them in Settings → Batch timetables.`); continue; }

      const hol = await cal.holidayMap(b._id, semester._id);
      for (const h of drafts) if (!h.batchIds.length || h.batchIds.includes(String(b._id))) for (const d of cal.rangeDays(h.from, h.to)) hol.set(d, h.title);
      const classDays = cal.rangeDays(g.start, g.end).filter(d => t.days.includes(cal.wd(d)) && !hol.has(d));
      row.classDays = classDays;
      row.holidays = cal.rangeDays(g.start, g.end).filter(d => hol.has(d) && t.days.includes(cal.wd(d))).map(d => ({ date: d, title: hol.get(d) }));
      if (!classDays.length) { row.errors.push('No class days in this range.'); continue; }

      const pd = g.projectDays?.[String(b._id)] || g.projectDay || null;
      row.projectDay = pd || classDays[classDays.length - 1];
      if (!classDays.includes(row.projectDay)) row.errors.push(`Project day ${row.projectDay} is not one of this batch's class days (${row.days.join(', ')}). Pick a different day for this batch.`);
      const after = classDays.filter(d => d > row.projectDay).length;
      if (after) row.warnings.push(`${after} class day(s) after the project day.`);

      const overlap = await Cycle.findOne({ batch: b._id, startDate: { $lte: perf.ymdToDay(g.end) }, endDate: { $gte: perf.ymdToDay(g.start) } }).lean();
      if (overlap) row.errors.push(`Overlaps Cycle ${overlap.number} (${perf.dayYmd(overlap.startDate)} – ${perf.dayYmd(overlap.endDate)}).`);
      const last = await Cycle.findOne({ batch: b._id }).sort('-number').lean();
      row.number = last ? last.number + 1 : 1;
      row.firstClass = await nextClassNumber(b._id);
      row.lastClass = row.firstClass + classDays.length - 1;
      if (g.start < perf.istYmd(new Date())) row.warnings.push('Starts in the past.');
    }
  }
  // What the new holidays touch in plans that already exist (nothing moves; flagged)
  const affected = [];
  for (const h of drafts) {
    const p = await cal.preview({ ...h, mode: 'mark' }, semester);
    for (const r of p.batches) for (const k of r.onHoliday) affected.push({ batch: r.batch, holiday: h.title, cycle: k.cycle, number: k.number, title: k.title, date: k.date });
  }
  const ok = !errors.length && rows.length > 0 && rows.every(r => !r.errors.length);
  return { ok, errors, batches: rows, holidays: drafts, affected };
}

async function create(input, semester, user) {
  const p = await preview(input, semester);
  if (!p.ok) throw new Error([...p.errors, ...p.batches.flatMap(r => r.errors.map(e => `${r.batch}: ${e}`))][0] || 'Nothing to create.');
  for (const h of p.holidays) await cal.apply({ ...h, mode: 'mark' }, semester, user);
  const created = [];
  for (const r of p.batches) {
    const c = await Cycle.create({ batch: r.batchId, semester: semester._id, number: r.number,
      startDate: perf.ymdToDay(r.start), endDate: perf.ymdToDay(r.end), createdBy: user._id,
      track: { tracked: true, trackedFrom: new Date(), projectDate: perf.ymdToDay(r.projectDay) } });
    const list = r.classDays.map((d, i) => ({ number: r.firstClass + i, date: d,
      title: d === r.projectDay ? `Cycle ${r.number} project day` : '' }));
    const s = await planStore.editPlan(user, c._id, () => list, { skipLock: true, note: 'Created by the cycle planner' });
    if (s.status !== 200) throw new Error(s.body?.message || 'Could not create the class rows');
    created.push({ batch: r.batch, cycleId: c._id, number: r.number, start: r.start, end: r.end, projectDay: r.projectDay, classes: list.length });
  }
  return { created, holidays: p.holidays.length };
}

module.exports = { preview, create };
