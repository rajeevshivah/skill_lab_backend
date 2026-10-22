// ─────────────────────────────────────────────────────────────────────
//  /api/performance — the Trainer Performance dashboard.
//  Visible to every signed-in user (trainers see exactly what management sees).
//  Only the superadmin can change deadlines, project days, tracking and excuses.
// ─────────────────────────────────────────────────────────────────────
const express  = require('express');
const Cycle    = require('../models/Cycle');
const Semester = require('../models/Semester');
const { protect, superadminOnly } = require('../middleware/auth');
const perf     = require('../services/performance');
const router   = express.Router();

// Accounts that only review (e.g. "MD (Review)") are not scored.
const isReviewer = (u) => /\(review\)/i.test(u?.name || '');

async function semesterFor(req) {
  if (req.query.semester) return Semester.findById(req.query.semester);
  return Semester.findOne({ status: 'active' });
}

// Builds the whole dashboard for one cycle number (the "round").
async function buildDashboard(semester, number) {
  const all = await Cycle.find({ semester: semester._id })
    .select('number track startDate endDate batch').lean();
  const rounds = [...new Set(all.map(c => c.number))].sort((a, b) => a - b).map(n => ({
    number: n,
    tracked: all.some(c => c.number === n && c.track?.tracked),
    batches: all.filter(c => c.number === n).length,
  }));
  if (!rounds.length) return { semester: { id: semester._id, name: semester.name }, rounds, number: null, rows: [], trainers: [] };
  // Default: the latest tracked cycle that has already started (else the latest tracked, else the latest)
  const started = (n) => all.some(c => c.number === n && c.startDate <= new Date());
  const pick = number && rounds.some(r => r.number === number) ? number
    : ([...rounds].reverse().find(r => r.tracked && started(r.number))
      || [...rounds].reverse().find(r => r.tracked) || rounds[rounds.length - 1]).number;

  const cycles = await Cycle.find({ semester: semester._id, number: pick })
    .populate({ path: 'batch', select: 'name track trainers', populate: { path: 'trainers', select: 'name role' } })
    .populate('track.report.by track.marks.by track.top3.by track.plan.by', 'name');

  const rows = [];
  for (const c of cycles) {
    const s = await perf.scoreCycle(c);
    const stampOf = (k) => c.track?.[k]?.at ? { at: c.track[k].at, by: c.track[k].by?.name || '', admin: !!c.track[k].admin } : null;
    rows.push({
      cycleId: c._id, number: c.number, status: undefined,
      batch: c.batch?.name || '', batchId: c.batch?._id, track: c.batch?.track || '',
      trainers: (c.batch?.trainers || []).filter(t => !isReviewer(t)).map(t => ({ id: t._id, name: t.name })),
      start: perf.dayYmd(c.startDate), end: perf.dayYmd(c.endDate),
      projectDate: perf.dayYmd(s.projectDate), deadline: s.deadline,
      tracked: s.tracked, excusedNote: s.excusedNote,
      overall: s.overall, completedAt: s.completedAt, lateBy: s.lateBy, lateEdits: s.lateEdits,
      score: s.tracked ? s.score : null,
      items: s.items,
      who: { report: stampOf('report'), marks: stampOf('marks'), top3: stampOf('top3'), plan: stampOf('plan') },
    });
  }
  rows.sort((a, b) => a.batch.localeCompare(b.batch));

  // Trainer scores: this round + average of every tracked round this semester
  const tracked = await Cycle.find({ semester: semester._id, 'track.tracked': true })
    .populate({ path: 'batch', select: 'name trainers', populate: { path: 'trainers', select: 'name' } });
  const per = new Map();   // trainerId → { name, scores: [{number, score}] }
  for (const c of tracked) {
    const s = c.number === pick ? rows.find(r => String(r.cycleId) === String(c._id)) : await perf.scoreCycle(c);
    if (s?.score == null) continue;
    for (const t of c.batch?.trainers || []) {
      if (isReviewer(t)) continue;
      const e = per.get(String(t._id)) || { id: t._id, name: t.name, scores: [] };
      e.scores.push({ number: c.number, batch: c.batch.name, score: s.score });
      per.set(String(t._id), e);
    }
  }
  const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  const trainers = [...per.values()].map(t => ({
    id: t.id, name: t.name,
    thisCycle: avg(t.scores.filter(s => s.number === pick).map(s => s.score)),
    semesterAvg: avg(t.scores.map(s => s.score)),
    cyclesScored: new Set(t.scores.map(s => s.number)).size,
    batches: [...new Set(t.scores.filter(s => s.number === pick).map(s => s.batch))],
  })).sort((a, b) => (b.thisCycle ?? -1) - (a.thisCycle ?? -1) || (b.semesterAvg ?? -1) - (a.semesterAvg ?? -1));

  return {
    semester: { id: semester._id, name: semester.name }, rounds, number: pick,
    weights: perf.WEIGHTS, rows, trainers, generatedAt: new Date(),
  };
}

// GET /api/performance?number=4
router.get('/', protect, async (req, res) => {
  try {
    const semester = await semesterFor(req);
    if (!semester) return res.json({ semester: null, rounds: [], rows: [], trainers: [] });
    res.json(await buildDashboard(semester, Number(req.query.number) || null));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/performance/cycle/:id  (admin) — { projectDate:'YYYY-MM-DD', deadline:'YYYY-MM-DDTHH:mm' (IST) | null, excusedNote, tracked }
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
    c.markModified('track');
    await c.save();
    res.json({ ok: true, deadline: perf.deadlineOf(c) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/performance/round/:number  (admin) — same change for every batch's cycle with this number
// { tracked, deadline } (project days stay per batch)
router.patch('/round/:number', protect, superadminOnly, async (req, res) => {
  try {
    const semester = await semesterFor(req);
    if (!semester) return res.status(400).json({ message: 'No active semester' });
    const cycles = await Cycle.find({ semester: semester._id, number: Number(req.params.number) });
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
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.__shared = { buildDashboard };
module.exports = router;
