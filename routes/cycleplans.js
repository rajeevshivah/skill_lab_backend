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

const store = require('../services/planStore');

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
      const plan = await CyclePlan.findOne({ cycle: c._id }).populate('classes.trainer', 'name').populate('classes.updatedBy', 'name').populate('changes.by', 'name').lean();
      const logs = await DailyLog.find({ batch: c.batch._id, date: { $gte: c.startDate, $lte: c.endDate } })
        .select('date status planClass github notes completeAt loggedBy').populate('loggedBy', 'name').lean();
      const logBy = new Map(logs.map(l => [ymdOf(l.date), l]));
      const s = ymdOf(c.startDate), e = ymdOf(c.endDate);
      const pulseBy = new Map((await sv.pulseSummary(c.batch._id, s, e)).map(p => [p.date, p]));
      const holTitle = await sv.holidaysBetween(c.batch._id, s, e);
      const mine = (c.batch.trainers || []).some(t => String(t._id) === String(req.user._id));
      const complete = store.isComplete(plan?.classes);
      const logView = (l) => l && ({ status: l.status, planClass: l.planClass, github: l.github, by: l.loggedBy?.name || '',
        missing: ymdOf(l.date) >= logRule.RULE_FROM ? missingParts(l) : [] });
      const classes = (plan?.classes || []).map(k => ({
        number: k.number, title: k.title, notes: k.notes, date: k.date, time: k.time,
        trainer: k.trainer ? { _id: k.trainer._id, name: k.trainer.name } : null,
        updatedAt: k.updatedAt || null, updatedBy: k.updatedBy?.name || '', updatedById: k.updatedBy?._id || null,
        inCycle: !k.date || (k.date >= s && k.date <= e),
        holiday: k.date ? holTitle(k.date) : null,
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
        canEdit: isAdmin || (mine && (c.planOpen || !complete)), mine, complete, version: plan ? plan.__v : null,
        classes, extraLogs,
        changes: (plan?.changes || []).slice(-8).reverse().map(x => ({ at: x.at, by: x.by?.name || '', text: x.text })),
      });
    }
    out.sort((a, b) => a.batch.name.localeCompare(b.batch.name));
    const Holiday = require('../models/Holiday');
    const pS = ymdOf(pick.start), pE = ymdOf(pick.end);
    const hols = await Holiday.find({ semester: semester._id, from: { $lte: pE }, to: { $gte: pS } }).populate('batches', 'name').lean();
    res.json({
      periods: periods.map(p => ({ key: p.key, numbers: [...p.numbers].sort((a, b) => a - b), batches: p.batches, start: ymdOf(p.start), end: ymdOf(p.end) })),
      period: pick.key, start: ymdOf(pick.start), end: ymdOf(pick.end), isAdmin, ruleFrom: logRule.RULE_FROM, cycles: out,
      holidays: hols.map(h => ({ from: h.from, to: h.to, title: h.title, batches: (h.batches || []).map(b => b.name) })),
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
      version: plan.__v ?? null,
      planOpen: !!cycle.planOpen,
      complete: store.isComplete(plan.classes),
      canEdit: (await store.editRight(req.user, cycle, plan.classes || [])).ok,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/cycleplans/:cycleId — save the whole class list.
// body: { classes: [{number,title,notes,trainer,date,time}], version? } (version = the plan version you loaded)
router.put('/:cycleId', protect, async (req, res) => {
  try {
    const r = await store.saveCyclePlan(req.user, req.params.cycleId, req.body.classes, { baseVersion: req.body.version });
    res.status(r.status).json(r.body);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// One class at a time (Class plans board). Each sends the row's updatedAt it loaded;
// if someone changed that row since → 409 with the current row.
// POST   /api/cycleplans/:cycleId/class            { number, title, notes, date, time, trainer }  — add
// PATCH  /api/cycleplans/:cycleId/class/:number    { …fields, baseUpdatedAt }                     — edit (number may change)
// DELETE /api/cycleplans/:cycleId/class/:number?baseUpdatedAt=…                                   — remove
router.post('/:cycleId/class', protect, async (req, res) => {
  try {
    const r = await store.editRow(req.user, req.params.cycleId, req.body.number, req.body, { add: true });
    res.status(r.status).json(r.body);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.patch('/:cycleId/class/:number', protect, async (req, res) => {
  try {
    const { baseUpdatedAt, ...patch } = req.body;
    const r = await store.editRow(req.user, req.params.cycleId, req.params.number, patch, { baseUpdatedAt });
    res.status(r.status).json(r.body);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.delete('/:cycleId/class/:number', protect, async (req, res) => {
  try {
    const r = await store.editRow(req.user, req.params.cycleId, req.params.number, {}, { remove: true, baseUpdatedAt: req.query.baseUpdatedAt });
    res.status(r.status).json(r.body);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

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
router.__shared = { saveCyclePlan: store.saveCyclePlan, describeChanges: store.describeChanges };

module.exports = router;
