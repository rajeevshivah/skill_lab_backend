const express   = require('express');
const CyclePlan = require('../models/CyclePlan');
const Cycle     = require('../models/Cycle');
const Batch     = require('../models/Batch');
const DailyLog  = require('../models/DailyLog');
const Semester  = require('../models/Semester');
const { protect, canAccessBatch, superadminOnly } = require('../middleware/auth');
const logRule = require('../services/logRule');
const { missingParts } = logRule;
const sv = require('../services/studentView');
const perf = require('../services/performance');
const router    = express.Router();

// Short human description of what changed between two class lists (by class number).
function describeChanges(oldList, newList) {
  const key = (c) => String(c.number);
  const o = new Map(oldList.map(c => [key(c), c])), n = new Map(newList.map(c => [key(c), c]));
  const parts = [];
  const added = [...n.keys()].filter(k => !o.has(k)), removed = [...o.keys()].filter(k => !n.has(k));
  if (added.length) parts.push(`added class ${added.join(', ')}`);
  if (removed.length) parts.push(`removed class ${removed.join(', ')}`);
  for (const [k, c] of n) {
    const p = o.get(k); if (!p) continue;
    const f = [];
    if ((p.date || '') !== (c.date || '')) f.push(`date ${p.date || '—'} → ${c.date || '—'}`);
    if ((p.title || '') !== (c.title || '')) f.push('topic');
    if ((p.notes || '') !== (c.notes || '')) f.push('details');
    if ((p.time || '') !== (c.time || '')) f.push('time');
    if (String(p.trainer || '') !== String(c.trainer || '')) f.push('trainer');
    if (f.length) parts.push(`class ${k}: ${f.join(', ')}`);
  }
  return parts.join('; ').slice(0, 400);
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymdOf = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; };
const periodOf = (c) => perf.istYmd(perf.deadlineOf(c));

// All cycles of the semester grouped by deadline date (same grouping as the Performance page).
async function boardPeriods(semester) {
  const all = await Cycle.find({ semester: semester._id }).select('number startDate endDate track batch planOpen').lean();
  const map = new Map();
  for (const c of all) {
    const k = periodOf(c);
    const e = map.get(k) || { key: k, numbers: new Set(), batches: 0, start: c.startDate, end: c.endDate, ids: [] };
    e.numbers.add(c.number); e.batches++; e.ids.push(c._id);
    if (c.startDate < e.start) e.start = c.startDate;
    if (c.endDate > e.end) e.end = c.endDate;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// GET /api/cycleplans/board?period=YYYY-MM-DD — every batch's class plan for one cycle period, day by day
router.get('/board', protect, async (req, res) => {
  try {
    const semester = await Semester.findOne({ status: 'active' });
    if (!semester) return res.json({ periods: [], period: null, cycles: [] });
    const periods = await boardPeriods(semester);
    if (!periods.length) return res.json({ periods: [], period: null, cycles: [] });
    const now = new Date();
    const want = /^\d{4}-\d{2}-\d{2}$/.test(req.query.period || '') ? req.query.period : null;
    const pick = periods.find(p => p.key === want)
      || periods.find(p => p.start <= now && p.end >= new Date(now.getTime() - 86400000))
      || [...periods].reverse().find(p => p.start <= now) || periods[periods.length - 1];

    const cycles = await Cycle.find({ _id: { $in: pick.ids } })
      .populate({ path: 'batch', select: 'name track trainers', populate: { path: 'trainers', select: 'name isActive' } })
      .populate('planOpenBy', 'name');
    const isAdmin = req.user.role === 'superadmin';
    const out = [];
    for (const c of cycles) {
      const plan = await CyclePlan.findOne({ cycle: c._id }).populate('classes.trainer', 'name').populate('changes.by', 'name').lean();
      const logs = await DailyLog.find({ batch: c.batch._id, date: { $gte: c.startDate, $lte: c.endDate } })
        .select('date status planClass github notes completeAt loggedBy').populate('loggedBy', 'name').lean();
      const logBy = new Map(logs.map(l => [ymdOf(l.date), l]));
      const s = ymdOf(c.startDate), e = ymdOf(c.endDate);
      const pulseBy = new Map((await sv.pulseSummary(c.batch._id, s, e)).map(p => [p.date, p]));
      const mine = (c.batch.trainers || []).some(t => String(t._id) === String(req.user._id));
      const hasPlan = !!(plan?.classes || []).length;
      const logView = (l) => l && ({ status: l.status, planClass: l.planClass, github: l.github, by: l.loggedBy?.name || '',
        missing: ymdOf(l.date) >= logRule.RULE_FROM ? missingParts(l) : [] });
      const classes = (plan?.classes || []).map(k => ({
        number: k.number, title: k.title, notes: k.notes, date: k.date, time: k.time,
        trainer: k.trainer ? { _id: k.trainer._id, name: k.trainer.name } : null,
        inCycle: !k.date || (k.date >= s && k.date <= e),
        log: k.date ? logView(logBy.get(k.date)) : null,
        pulse: k.date && pulseBy.has(k.date) ? (() => {
          const p = pulseBy.get(k.date), l = logBy.get(k.date);
          // Trainer says "done as planned" but most students say it wasn't covered
          return { ...p, mismatch: !!l && l.status === 'done' && p.responses >= 5 && p.coveredPct < 50 };
        })() : null,
      })).sort((a, b) => a.number - b.number);
      const planned = new Set(classes.map(k => k.date).filter(Boolean));
      const extraLogs = logs.filter(l => !planned.has(ymdOf(l.date))).map(l => ({ date: ymdOf(l.date), ...logView(l) }));
      out.push({
        cycleId: c._id, number: c.number, start: s, end: e,
        batch: { _id: c.batch._id, name: c.batch.name, track: c.batch.track },
        trainers: (c.batch.trainers || []).filter(t => t.isActive !== false).map(t => ({ _id: t._id, name: t.name })),
        planOpen: !!c.planOpen, planOpenBy: c.planOpenBy?.name || '', planOpenAt: c.planOpenAt,
        canEdit: isAdmin || (mine && (c.planOpen || !hasPlan)), mine,
        classes, extraLogs,
        changes: (plan?.changes || []).slice(-8).reverse().map(x => ({ at: x.at, by: x.by?.name || '', text: x.text })),
      });
    }
    out.sort((a, b) => a.batch.name.localeCompare(b.batch.name));
    res.json({
      periods: periods.map(p => ({ key: p.key, numbers: [...p.numbers].sort((a, b) => a - b), batches: p.batches, start: ymdOf(p.start), end: ymdOf(p.end) })),
      period: pick.key, start: ymdOf(pick.start), end: ymdOf(pick.end), isAdmin, ruleFrom: logRule.RULE_FROM, cycles: out,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/cycleplans/board/open  (admin) — { open: true|false, period } or { open, cycleId }
// Opens / locks plan editing for trainers.
router.patch('/board/open', protect, superadminOnly, async (req, res) => {
  try {
    const open = !!req.body.open;
    let filter;
    if (req.body.cycleId) filter = { _id: req.body.cycleId };
    else {
      const semester = await Semester.findOne({ status: 'active' });
      const p = semester && (await boardPeriods(semester)).find(x => x.key === req.body.period);
      if (!p) return res.status(404).json({ message: 'Period not found' });
      filter = { _id: { $in: p.ids } };
    }
    const r = await Cycle.updateMany(filter, { $set: { planOpen: open, planOpenBy: open ? req.user._id : null, planOpenAt: open ? new Date() : null } });
    res.json({ ok: true, open, cycles: r.modifiedCount ?? r.nModified ?? 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/cycleplans/:cycleId  — the class-wise plan + the batch's trainers (for the picker)
router.get('/:cycleId', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.cycleId)
      .populate({ path: 'batch', select: 'name track trainers', populate: { path: 'trainers', select: 'name' } });
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });

    let plan = await CyclePlan.findOne({ cycle: cycle._id })
      .populate('classes.trainer', 'name');
    if (!plan) plan = { cycle: cycle._id, batch: cycle.batch._id, classes: [] };

    res.json({
      cycle: { _id: cycle._id, number: cycle.number, name: cycle.name, status: cycle.status,
               batch: { _id: cycle.batch._id, name: cycle.batch.name, track: cycle.batch.track },
               startDate: cycle.startDate, endDate: cycle.endDate },
      trainers: cycle.batch.trainers || [],
      classes: plan.classes || [],
      planOpen: !!cycle.planOpen,
      canEdit: req.user.role === 'superadmin' || ((cycle.batch.trainers || []).some(t => String(t._id) === String(req.user._id))
        && (cycle.planOpen || !(plan.classes || []).length)),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/cycleplans/:cycleId  — save the whole class list
// body: { classes: [{number,title,notes,trainer,date,time}] }
router.put('/:cycleId', protect, async (req, res) => {
  try {
    const r = await saveCyclePlan(req.user, req.params.cycleId, req.body.classes);
    res.status(r.status).json(r.body);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Save logic shared by the route above and the MCP tool save_cycle_plan_class.
// Replaces the whole class list with `inputClasses`.
async function saveCyclePlan(user, cycleId, inputClasses) {
    const req = { user };
    const cycle = await Cycle.findById(cycleId);
    if (!cycle) return { status: 404, body: { message: 'Cycle not found' } };
    if (!(await canAccessBatch(req.user, cycle.batch)))
      return { status: 403, body: { message: 'Not your batch' } };
    const before = await CyclePlan.findOne({ cycle: cycle._id }).lean();
    const hadPlan = !!(before?.classes || []).length;
    // Trainers fill an empty plan freely; once a plan exists, only while the admin has opened editing.
    if (req.user.role !== 'superadmin' && hadPlan && !cycle.planOpen)
      return { status: 403, body: { message: 'This plan is locked. Plans can be changed only while the admin has opened editing (for example in the planning meeting). Ask the admin.' } };

    const incoming = Array.isArray(inputClasses) ? inputClasses : [];
    const classes = incoming.map((c, i) => ({
      number: c.number || i + 1,
      title:  (c.title || '').trim(),
      notes:  (c.notes || '').trim(),
      trainer: c.trainer || null,
      date:   c.date || '',
      time:   c.time || '',
    }));

    const text = describeChanges(before?.classes || [], classes);
    const changes = [...(before?.changes || [])];
    if (text) changes.push({ at: new Date(), by: req.user._id, text });
    const plan = await CyclePlan.findOneAndUpdate(
      { cycle: cycle._id },
      { cycle: cycle._id, batch: cycle.batch, semester: cycle.semester, classes, updatedBy: req.user._id,
        changes: changes.slice(-60) },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('classes.trainer', 'name');

    if (classes.length) { await perf.stamp(cycle, 'plan', req.user); await cycle.save(); }
    return { status: 200, body: { classes: plan.classes } };
}

// GET /api/cycleplans/for-date?batch=ID&date=YYYY-MM-DD
// Returns the planned class (if any) for that batch/date, by scanning the cycle
// whose date range contains the date and matching the class entry's date.
router.get('/for-date/lookup', protect, async (req, res) => {
  try {
    const { batch, date } = req.query;
    if (!batch || !date) return res.status(400).json({ message: 'batch and date required' });
    const d = new Date(date); d.setHours(12,0,0,0);
    // find the cycle for this batch covering the date
    const cycle = await Cycle.findOne({ batch, startDate: { $lte: d }, endDate: { $gte: d } });
    if (!cycle) return res.json({ planned: null, cycle: null });
    const plan = await CyclePlan.findOne({ cycle: cycle._id }).populate('classes.trainer', 'name');
    if (!plan) return res.json({ planned: null, cycle: { _id: cycle._id, number: cycle.number } });
    const planned = (plan.classes || []).find(c => c.date === date) || null;
    const classes = (plan.classes || []).map(c => ({ number: c.number, title: c.title, date: c.date })).sort((a, b) => a.number - b.number);
    res.json({ planned, classes, cycle: { _id: cycle._id, number: cycle.number } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Shared with the MCP write tools (mcp/writeTools.js).
router.__shared = { saveCyclePlan, describeChanges };

module.exports = router;
