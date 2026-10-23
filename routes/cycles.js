const express  = require('express');
const mongoose = require('mongoose');
const Cycle    = require('../models/Cycle');
const Batch    = require('../models/Batch');
const DailyLog = require('../models/DailyLog');
const CyclePlan = require('../models/CyclePlan');
const sv       = require('../services/studentView');
const topThree = require('../services/topThree');
const studentStats = require('../services/studentStats');
const Student  = require('../models/Student');
const Semester = require('../models/Semester');
const { protect, superadminOnly, canAccessBatch } = require('../middleware/auth');
const perf = require('../services/performance');
const planner = require('../services/cyclePlanner');
const router   = express.Router();

function dayKey(d) { const dt = new Date(d); dt.setHours(0,0,0,0); return dt; }

// Live report numbers for a cycle — all from the cycle's own records:
//   sessions held / attendance — daily logs in the cycle (not "no class" days)
//   classes planned / completed — the cycle plan (holidays left out) vs logs marked done
//   Top 3 — ranked from the marks (services/topThree.js)
async function computeLiveData(cycle) {
  const s = perf.dayYmd(cycle.startDate), e = perf.dayYmd(cycle.endDate);
  const end = dayKey(cycle.endDate); end.setHours(23, 59, 59, 999);
  const [logs, plan, holOf, ranked, totalStudents] = await Promise.all([
    DailyLog.find({ batch: cycle.batch, date: { $gte: dayKey(cycle.startDate), $lte: end } }).select('date status planClass attendance').lean(),
    CyclePlan.findOne({ cycle: cycle._id }).select('classes.number classes.date').lean(),
    sv.holidayFinder(s, e),
    topThree.rank(cycle),
    Student.countDocuments({ batch: cycle.batch }),
  ]);
  const held = logs.filter(l => l.status !== 'no-class');
  let present = 0, total = 0;
  for (const l of held) for (const a of l.attendance || []) { total++; if (a.present) present++; }
  const planned = (plan?.classes || []).filter(k => k.date && k.date >= s && k.date <= e && !holOf(cycle.batch, k.date));
  const doneNumbers = new Set(held.filter(l => l.status === 'done' && l.planClass != null).map(l => l.planClass));
  return {
    avgAttendance: total ? Math.round(present / total * 100) : null,
    sessionsHeld: held.length,
    topicsPlanned: planned.length,
    topicsCompleted: planned.filter(k => doneNumbers.has(k.number)).length,
    top3: ranked.map(({ rank, student, name, roll }) => ({ rank, student, name, roll })),
    totalStudents,
  };
}

// Can this user fill the cycle report now? Admin: any time until closed.
// Trainer of the batch: from the batch's project day (or earlier if the admin opened it).
function reportState(cycle, user) {
  const opensOn = perf.dayYmd(perf.projectDayOf(cycle));
  if (cycle.status === 'closed') return { open: false, opensOn, reason: 'This cycle is closed. Ask admin to reopen it.' };
  if (user.role === 'superadmin' || cycle.status === 'report-open' || perf.istYmd(new Date()) >= opensOn) return { open: true, opensOn };
  return { open: false, opensOn, reason: `The report opens on the project day (${opensOn}).` };
}

// GET /api/cycles/halloffame[?semester=ID]  (PUBLIC) — newest cycle with a top-3 per batch.
// Without ?semester it uses the active one and also returns the semester list, so the
// public page needs ONE request. Photos are NOT inlined: each top-3 entry carries a
// small cacheable photo URL (see /:id/photo/:rank below).
router.get('/halloffame', async (req, res) => {
  try {
    let semesters = null, semId = req.query.semester || null;
    if (!semId) {
      semesters = await Semester.find().select('name status startDate endDate').sort('-createdAt').lean();
      semId = (semesters.find(s => s.status === 'active') || semesters[0])?._id || null;
    }
    if (!semId) return res.json({ semester: null, semesters: semesters || [], cycles: [] });
    const cycles = await Cycle.find({ semester: semId, 'report.top3.0': { $exists: true } })
      .select('-track -report.top3.photo.data')
      .populate('batch', 'name track')
      .sort('-startDate').lean();

    // Only the newest cycle per batch belongs on the board — otherwise an
    // older cycle's top-3 keeps sitting alongside a newer one for the same
    // batch forever. `cycles` is newest-first, so keep the first per batch.
    const seenBatch = new Set();
    const latestPerBatch = cycles.filter(c => {
      const key = c.batch?._id ? String(c.batch._id) : `no-batch-${c._id}`;
      if (seenBatch.has(key)) return false;
      seenBatch.add(key);
      return true;
    });

    const out = latestPerBatch.map(c => ({
      _id: c._id, number: c.number, name: c.name,
      startDate: c.startDate, endDate: c.endDate,
      batch: c.batch ? { _id: c.batch._id, name: c.batch.name, track: c.batch.track } : null,
      top3: (c.report.top3 || []).sort((a, b) => a.rank - b.rank).map(t => ({
        rank: t.rank, name: t.name, roll: t.roll, github: t.github,
        photo: t.photo?.contentType ? `/cycles/${c._id}/photo/${t.rank}?v=${new Date(c.updatedAt || 0).getTime()}` : null,
      })),
    }));
    // A short public cache: the board changes a few times a cycle, not every second.
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ semester: semId, ...(semesters ? { semesters } : {}), cycles: out });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/cycles/:id/photo/:rank  (PUBLIC) — one top-3 photo as an image.
// The URL carries ?v=<last change>, so browsers may keep it for a year.
router.get('/:id/photo/:rank', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
    const c = await Cycle.findById(req.params.id).select('report.top3').lean();
    const t = (c?.report?.top3 || []).find(x => x.rank === Number(req.params.rank));
    if (!t?.photo?.data) return res.status(404).end();
    res.set('Content-Type', t.photo.contentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(t.photo.data, 'base64'));
  } catch (err) { res.status(500).end(); }
});

// GET /api/cycles?batch=ID  or ?semester=ID
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.query.batch)    filter.batch = req.query.batch;
    if (req.query.semester) filter.semester = req.query.semester;
    // trainers only see cycles of their own batches
    if (req.user.role !== 'superadmin') {
      const myBatches = await Batch.find({ trainers: req.user._id }).select('_id');
      filter.batch = { $in: myBatches.map(b => b._id) };
    }
    const cycles = await Cycle.find(filter).select('-report.top3.photo')   // photos: only on the report page / hall of fame
      .populate('batch', 'name track trainers')
      .sort('-startDate').lean();
    res.json({ cycles });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/cycles/:id  — includes live data if open, snapshot if closed
router.get('/:id', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.id).populate('batch', 'name track trainers');
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    let live = null;
    if (cycle.status !== 'closed') live = await computeLiveData(cycle);
    const rs = reportState(cycle, req.user);
    res.json({ cycle, live, reportOpen: rs.open, reportOpensOn: rs.opensOn, reportNote: rs.reason || '' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Creating cycles: ONLY through the cycle planner (services/cyclePlanner.js) ──
// POST /api/cycles/planner/preview  (admin) — { groups, holidays } → what would be created; saves nothing
router.post('/planner/preview', protect, superadminOnly, async (req, res) => {
  try {
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) return res.status(400).json({ message: 'No active semester' });
    res.json(await planner.preview(req.body || {}, sem));
  } catch (err) { res.status(400).json({ message: err.message }); }
});
// POST /api/cycles/planner  (admin) — create the cycles (+ holidays + dated class rows)
router.post('/planner', protect, superadminOnly, async (req, res) => {
  try {
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) return res.status(400).json({ message: 'No active semester' });
    res.status(201).json(await planner.create(req.body || {}, sem, req.user));
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// PATCH /api/cycles/:id  (admin) — edit dates/number/name (not while closed)
router.patch('/:id', protect, superadminOnly, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.id);
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    if (cycle.status === 'closed')
      return res.status(400).json({ message: 'Reopen the cycle before editing it.' });
    const { number, name, startDate, endDate } = req.body;
    if (number !== undefined)    cycle.number = number;
    if (name !== undefined)      cycle.name = name;
    if (startDate !== undefined) cycle.startDate = dayKey(startDate);
    if (endDate !== undefined)   cycle.endDate = dayKey(endDate);
    if (cycle.endDate < cycle.startDate) return res.status(400).json({ message: 'End date is before start date.' });
    const overlap = await Cycle.findOne({ _id: { $ne: cycle._id }, batch: cycle.batch, startDate: { $lte: cycle.endDate }, endDate: { $gte: cycle.startDate } });
    if (overlap) return res.status(400).json({ message: `Dates overlap with Cycle ${overlap.number} in this batch.` });
    await cycle.save();
    res.json({ cycle });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ message: 'That cycle number already exists for this batch.' });
    res.status(500).json({ message: err.message });
  }
});

// POST /api/cycles/:id/open  (admin) — open the report window for trainers
router.post('/:id/open', protect, superadminOnly, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.id);
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    cycle.status = 'report-open';
    cycle.closedAt = null;
    await cycle.save();
    res.json({ cycle });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/cycles/:id/close  (admin) — snapshot live numbers into the report and freeze
router.post('/:id/close', protect, superadminOnly, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.id);
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    const live = await computeLiveData(cycle);
    // freeze any auto fields the trainer didn't override
    const r = cycle.report;
    if (r.avgAttendance == null)   r.avgAttendance = live.avgAttendance;
    if (r.sessionsHeld == null)    r.sessionsHeld = live.sessionsHeld;
    if (r.topicsPlanned == null)   r.topicsPlanned = live.topicsPlanned;
    if (r.topicsCompleted == null) r.topicsCompleted = live.topicsCompleted;
    if ((!r.top3 || !r.top3.length) && !r.top3Manual) r.top3 = live.top3;   // from the marks
    if (r.totalStudents == null)   r.totalStudents = live.totalStudents;
    cycle.status = 'closed';
    cycle.closedAt = new Date();
    await cycle.save();
    await studentStats.recompute((r.top3 || []).map(t => t.student));
    res.json({ cycle });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/cycles/:id/report  — trainer (of the batch) or admin saves the report
router.put('/:id/report', protect, async (req, res) => {
  try {
    const r = await saveCycleReport(req.user, req.params.id, req.body);
    res.status(r.status).json(r.body);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Save logic shared by the route above and the MCP tools fill_cycle_report /
// set_cycle_top3. Only the fields present in `input` are changed.
async function saveCycleReport(user, cycleId, input) {
    const req = { user, body: input || {} };
    const cycle = await Cycle.findById(cycleId);
    if (!cycle) return { status: 404, body: { message: 'Cycle not found' } };
    if (!(await canAccessBatch(req.user, cycle.batch)))
      return { status: 403, body: { message: 'Not your batch' } };
    const rs = reportState(cycle, req.user);
    if (!rs.open) return { status: 400, body: { message: rs.reason } };

    const allowed = [
      'avgAttendance','sessionsHeld','topicsPlanned','topicsCompleted',
      'syllabusCoverage','coverageNote','submittedCount','totalStudents',
      'performanceRating','trainerConfidence','problemsFaced','improvementNeeded',
      'standoutStudents','strugglingStudents','topicsNotCovered','reflection',
      'projectTitle','projectNote',
    ];
    for (const k of allowed) if (k in req.body) cycle.report[k] = req.body[k];

    // "Back to automatic": drop the hand-made Top 3 and rank from the marks again.
    const before3 = (cycle.report.top3 || []).map(t => String(t.student || t.roll || t.name));
    if (req.body.top3Auto === true) {
      cycle.report.top3Manual = false;
      cycle.report.top3 = [];
      await topThree.publish(cycle, req.user);
    }
    // top3: sanitize photos (accept data-URL, store as {data,contentType}); cap 2MB each
    else if (Array.isArray(req.body.top3)) {
      const MAX = 2 * 1024 * 1024;
      cycle.report.top3 = req.body.top3.map(t => {
        let photo = { data: null, contentType: null };
        if (t.photo && typeof t.photo === 'string') {
          const m = t.photo.match(/^data:(image\/\w+);base64,(.+)$/);
          if (m && Buffer.from(m[2], 'base64').length <= MAX) photo = { data: m[2], contentType: m[1] };
        } else if (t.photo && t.photo.data) {
          photo = t.photo; // already stored shape (unchanged on re-save)
        }
        return {
          rank: t.rank, student: t.student || null,
          name: t.name || '', roll: t.roll || '', github: t.github || '', photo,
        };
      });
      // A different set or order of people than the stored Top 3 = a hand-made choice;
      // from now on new marks don't overwrite it. (Adding photos/links is not a change.)
      const after3 = cycle.report.top3.map(t => String(t.student || t.roll || t.name));
      if (after3.join(',') !== before3.join(',')) cycle.report.top3Manual = true;
    }

    cycle.report.submitted = true;
    cycle.report.submittedBy = req.user._id;
    cycle.report.submittedAt = new Date();
    // Accountability stamps: the report form counts once any trainer field is
    // given; Top 3 counts once a non-empty Top 3 is saved.
    if (allowed.some(k => k in req.body)) await perf.stamp(cycle, 'report', req.user);
    if (Array.isArray(req.body.top3) && req.body.top3.length) await perf.stamp(cycle, 'top3', req.user);
    await cycle.save();
    const changed3 = (cycle.report.top3 || []).map(t => String(t.student || ''));
    if (changed3.join(',') !== before3.join(',')) await studentStats.recompute([...before3, ...changed3].filter(x => /^[a-f0-9]{24}$/.test(x)));
    return { status: 200, body: { cycle } };
}

// DELETE /api/cycles/:id  (admin) — also removes the cycle's marks and class plan,
// which used to be left behind pointing at a cycle that no longer existed.
router.delete('/:id', protect, superadminOnly, async (req, res) => {
  try {
    const CycleMark = require('../models/CycleMark');
    const CyclePlan = require('../models/CyclePlan');
    const removed = await CycleMark.deleteMany({ cycle: req.params.id });
    await CyclePlan.deleteMany({ cycle: req.params.id });
    await require('../models/ProjectSubmission').deleteMany({ cycle: req.params.id });
    await Cycle.findByIdAndDelete(req.params.id);
    res.json({ message: 'Cycle deleted', removedMarks: removed.deletedCount || 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Exported for tests — pure helpers, no database involved.
// Shared with the MCP write tools (mcp/writeTools.js).
router.__shared = { saveCycleReport, computeLiveData };

module.exports = router;
