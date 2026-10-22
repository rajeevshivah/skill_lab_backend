// ─────────────────────────────────────────────────────────────────────
//  /api/performance — the Trainer Performance dashboard.
//  Visible to every signed-in user (trainers see exactly what management sees).
//  Only the superadmin changes deadlines, project days, tracking, excuses,
//  leads/owners, and approves "waiting on" requests. A task owner may raise one.
//
//  Cycles are grouped by DEADLINE DATE ("period"), not by cycle number, so
//  batches that started at different times (1st year Cycle 1, 3rd sem Cycle 3)
//  but finished together appear side by side.
// ─────────────────────────────────────────────────────────────────────
const express  = require('express');
const mongoose = require('mongoose');
const Cycle    = require('../models/Cycle');
const Batch    = require('../models/Batch');
const Semester = require('../models/Semester');
const { protect, superadminOnly } = require('../middleware/auth');
const perf     = require('../services/performance');
const router   = express.Router();
const { isReviewer, sid } = perf;

async function semesterFor(req) {
  if (req.query.semester) return Semester.findById(req.query.semester);
  return Semester.findOne({ status: 'active' });
}
const periodOf = (c) => perf.istYmd(perf.deadlineOf(c));

// Builds the dashboard for one deadline period (or, for old callers, one cycle number).
async function buildDashboard(semester, { period = null, number = null } = {}) {
  const all = await Cycle.find({ semester: semester._id }).select('number track startDate endDate batch').lean();
  const map = new Map();
  for (const c of all) {
    const k = periodOf(c);
    const e = map.get(k) || { key: k, numbers: new Set(), tracked: false, batches: 0, started: false };
    e.numbers.add(c.number); e.batches++; e.tracked = e.tracked || !!c.track?.tracked;
    e.started = e.started || c.startDate <= new Date();
    map.set(k, e);
  }
  const periods = [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map(e => ({ key: e.key, numbers: [...e.numbers].sort((a, b) => a - b), tracked: e.tracked, batches: e.batches, started: e.started }));
  const base = { semester: { id: semester._id, name: semester.name }, periods, rounds: periods, weights: perf.WEIGHTS };
  if (!periods.length) return { ...base, period: null, rows: [], trainers: [] };

  let pick = null, filter;
  if (number) filter = (c) => c.number === number;
  else {
    pick = period && map.has(period) ? period
      : ([...periods].reverse().find(p => p.tracked && p.started) || [...periods].reverse().find(p => p.started) || periods[periods.length - 1]).key;
    filter = (c) => periodOf(c) === pick;
  }
  const ids = all.filter(filter).map(c => c._id);
  const cycles = await Cycle.find({ _id: { $in: ids } })
    .populate({ path: 'batch', select: 'name track trainers', populate: { path: 'trainers', select: 'name role isActive' } })
    .populate('track.report.by track.marks.by track.top3.by track.plan.by track.waits.owner track.waits.waitingOn', 'name');

  const rows = [];
  for (const c of cycles) {
    const s = await perf.scoreCycle(c);
    const stampOf = (k) => c.track?.[k]?.at ? { at: c.track[k].at, by: c.track[k].by?.name || '', admin: !!c.track[k].admin } : null;
    rows.push({
      cycleId: c._id, number: c.number,
      batch: c.batch?.name || '', batchId: c.batch?._id, track: c.batch?.track || '',
      trainers: (c.batch?.trainers || []).filter(t => !isReviewer(t) && t.isActive !== false).map(t => ({ id: t._id, name: t.name })),
      start: perf.dayYmd(c.startDate), end: perf.dayYmd(c.endDate),
      projectDate: perf.dayYmd(s.projectDate), deadline: s.deadline, period: periodOf(c),
      tracked: s.tracked, excusedNote: s.excusedNote,
      overall: s.overall, completedAt: s.completedAt, lateBy: s.lateBy, lateEdits: s.lateEdits,
      score: s.tracked ? s.score : null,
      items: s.items,
      lead: s.lead, owners: s.owners,
      perTrainer: s.perTrainer.map(p => ({ ...p, score: s.tracked ? p.score : null })),
      waits: (c.track?.waits || []).map(w => ({ id: w._id, item: w.item, owner: w.owner?.name || '', ownerId: sid(w.owner),
        waitingOn: w.waitingOn?.name || '', waitingOnId: sid(w.waitingOn), note: w.note, raisedAt: w.raisedAt, status: w.status, decidedAt: w.decidedAt })),
      who: { report: stampOf('report'), marks: stampOf('marks'), top3: stampOf('top3'), plan: stampOf('plan') },
    });
  }
  rows.sort((a, b) => a.batch.localeCompare(b.batch));

  // Trainer scores: this period + average over every tracked cycle this semester (per-trainer scores)
  const tracked = await Cycle.find({ semester: semester._id, 'track.tracked': true });
  const per = new Map();
  for (const c of tracked) {
    const row = rows.find(r => String(r.cycleId) === String(c._id));
    const pts = row ? row.perTrainer : (await perf.scoreCycle(c)).perTrainer;
    const bname = row ? row.batch : (await Batch.findById(c.batch).select('name').lean())?.name || '';
    for (const p of pts) {
      if (p.score == null) continue;
      const e = per.get(p.id) || { id: p.id, name: p.name, scores: [] };
      e.scores.push({ cycleId: String(c._id), here: !!row, batch: bname, score: p.score });
      per.set(p.id, e);
    }
  }
  const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  const trainers = [...per.values()].map(t => ({
    id: t.id, name: t.name,
    thisCycle: avg(t.scores.filter(s => s.here).map(s => s.score)),
    semesterAvg: avg(t.scores.map(s => s.score)),
    cyclesScored: t.scores.length,
    batches: [...new Set(t.scores.filter(s => s.here).map(s => s.batch))],
  })).sort((a, b) => (b.thisCycle ?? -1) - (a.thisCycle ?? -1) || (b.semesterAvg ?? -1) - (a.semesterAvg ?? -1));

  return { ...base, period: pick, number: number || null, rows, trainers, generatedAt: new Date() };
}

// GET /api/performance?period=2026-10-17   (or ?number=4)
router.get('/', protect, async (req, res) => {
  try {
    const semester = await semesterFor(req);
    if (!semester) return res.json({ semester: null, periods: [], rows: [], trainers: [] });
    res.json(await buildDashboard(semester, {
      period: /^\d{4}-\d{2}-\d{2}$/.test(req.query.period || '') ? req.query.period : null,
      number: Number(req.query.number) || null,
    }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// trainers of a cycle's batch who can own tasks (active, not review accounts)
async function eligibleTrainers(cycle) {
  const b = await Batch.findById(cycle.batch).select('trainers').populate('trainers', 'name isActive').lean();
  return (b?.trainers || []).filter(t => t.isActive !== false && !isReviewer(t));
}

// PATCH /api/performance/cycle/:id  (admin)
// { projectDate, deadline (IST 'YYYY-MM-DDTHH:mm' | null), excusedNote, tracked,
//   lead: userId|null, owners: { report|marks|top3|plan: userId|null }, stamps: {...} }
router.patch('/cycle/:id', protect, superadminOnly, async (req, res) => {
  try {
    const c = await Cycle.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'Cycle not found' });
    if (!c.track) c.track = {};
    const b = req.body || {};
    if ('projectDate' in b) c.track.projectDate = b.projectDate ? perf.ymdToDay(b.projectDate) : null;
    if ('deadline' in b) {
      const d = b.deadline ? perf.istToDate(b.deadline) : null;
      if (b.deadline && !d) return res.status(400).json({ message: 'Deadline must look like 2026-10-17T19:00' });
      c.track.deadline = d;
    }
    if ('excusedNote' in b) c.track.excusedNote = String(b.excusedNote || '').slice(0, 300);
    if ('tracked' in b) c.track.tracked = !!b.tracked;
    if ('lead' in b || 'owners' in b) {
      const elig = await eligibleTrainers(c);
      const ok = (u) => u == null || u === '' || elig.some(t => sid(t) === String(u));
      if ('lead' in b) {
        if (!ok(b.lead)) return res.status(400).json({ message: 'The lead must be a trainer of this batch.' });
        c.track.lead = b.lead || null;
      }
      if (b.owners && typeof b.owners === 'object') {
        if (!c.track.owners) c.track.owners = {};
        for (const k of ['report', 'marks', 'top3', 'plan']) {
          if (!(k in b.owners)) continue;
          if (!ok(b.owners[k])) return res.status(400).json({ message: `${k}: owner must be a trainer of this batch.` });
          c.track.owners[k] = b.owners[k] || null;
        }
      }
    }
    // Record when an item was completed and by whom (for cycles finished before tracking existed).
    if (b.stamps && typeof b.stamps === 'object') {
      for (const item of ['report', 'marks', 'top3', 'plan']) {
        if (!(item in b.stamps)) continue;
        const st = b.stamps[item];
        if (st === null) { c.track[item] = null; continue; }
        const at = perf.istToDate(st.at);
        if (!at) return res.status(400).json({ message: `${item}: time must look like 2026-10-17T21:00` });
        c.track[item] = { at, by: st.by || null, admin: !!st.admin };
      }
    }
    c.markModified('track');
    await c.save();
    res.json({ ok: true, deadline: perf.deadlineOf(c) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/performance/cycle/:id/wait  — the task's owner (or admin) says "waiting on <trainer>"
// { item: 'report'|'marks'|'top3', waitingOn: userId, note }
router.post('/cycle/:id/wait', protect, async (req, res) => {
  try {
    const c = await Cycle.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'Cycle not found' });
    const { item, waitingOn, note } = req.body || {};
    if (!['report', 'marks', 'top3'].includes(item)) return res.status(400).json({ message: 'item must be report, marks or top3' });
    const s = await perf.scoreCycle(c);
    const owner = s.owners[item];
    const isAdmin = req.user.role === 'superadmin';
    if (!isAdmin && (!owner || owner.id !== sid(req.user))) return res.status(403).json({ message: 'Only the owner of this task (or the admin) can raise this.' });
    if (s.items[item]?.at) return res.status(400).json({ message: 'This task is already done.' });
    const elig = await eligibleTrainers(c);
    if (!elig.some(t => sid(t) === String(waitingOn))) return res.status(400).json({ message: 'Pick another trainer of this batch.' });
    if (owner && String(waitingOn) === owner.id) return res.status(400).json({ message: 'You cannot wait on yourself.' });
    if ((c.track?.waits || []).some(w => w.item === item && w.status === 'pending'))
      return res.status(400).json({ message: 'There is already a pending request for this task.' });
    if (!c.track) c.track = {};
    c.track.waits = [...(c.track.waits || []), {
      item, owner: owner ? owner.id : req.user._id, waitingOn, note: String(note || '').slice(0, 300),
      raisedAt: new Date(), status: 'pending',
    }];
    c.markModified('track');
    await c.save();
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/performance/cycle/:id/wait/:waitId  (admin) — { status: 'approved' | 'rejected' }
router.patch('/cycle/:id/wait/:waitId', protect, superadminOnly, async (req, res) => {
  try {
    const c = await Cycle.findById(req.params.id);
    if (!c) return res.status(404).json({ message: 'Cycle not found' });
    const w = (c.track?.waits || []).find(x => String(x._id) === req.params.waitId);
    if (!w) return res.status(404).json({ message: 'Request not found' });
    const st = req.body?.status;
    if (!['approved', 'rejected'].includes(st)) return res.status(400).json({ message: 'status must be approved or rejected' });
    w.status = st; w.decidedAt = new Date(); w.decidedBy = req.user._id;
    c.markModified('track');
    await c.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/performance/period/:date  (admin) — same change for every cycle due that day: { tracked, deadline }
// PATCH /api/performance/round/:number  (admin) — same, for every cycle with that number
async function bulk(req, res, cycles) {
  const b = req.body || {};
  let deadline;
  if ('deadline' in b) {
    deadline = b.deadline ? perf.istToDate(b.deadline) : null;
    if (b.deadline && !deadline) return res.status(400).json({ message: 'Deadline must look like 2026-10-17T19:00' });
  }
  for (const c of cycles) {
    if (!c.track) c.track = {};
    if ('tracked' in b) c.track.tracked = !!b.tracked;
    if ('deadline' in b) c.track.deadline = deadline;
    c.markModified('track');
    await c.save();
  }
  res.json({ ok: true, updated: cycles.length });
}
router.patch('/period/:date', protect, superadminOnly, async (req, res) => {
  try {
    const semester = await semesterFor(req);
    if (!semester) return res.status(400).json({ message: 'No active semester' });
    const cycles = (await Cycle.find({ semester: semester._id })).filter(c => periodOf(c) === req.params.date);
    await bulk(req, res, cycles);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.patch('/round/:number', protect, superadminOnly, async (req, res) => {
  try {
    const semester = await semesterFor(req);
    if (!semester) return res.status(400).json({ message: 'No active semester' });
    await bulk(req, res, await Cycle.find({ semester: semester._id, number: Number(req.params.number) }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.__shared = { buildDashboard };
module.exports = router;
