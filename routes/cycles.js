const express  = require('express');
const Cycle    = require('../models/Cycle');
const Batch    = require('../models/Batch');
const DailyLog = require('../models/DailyLog');
const Plan     = require('../models/Plan');
const Topper   = require('../models/Topper');
const Student  = require('../models/Student');
const Semester = require('../models/Semester');
const { protect, superadminOnly, canAccessBatch } = require('../middleware/auth');
const router   = express.Router();

function dayKey(d) { const dt = new Date(d); dt.setHours(0,0,0,0); return dt; }

// Compute live report numbers for a cycle from daily logs / plan / toppers in its date range.
async function computeLiveData(cycle) {
  const start = dayKey(cycle.startDate);
  const end   = dayKey(cycle.endDate); end.setHours(23,59,59,999);

  const logs = await DailyLog.find({ batch: cycle.batch, date: { $gte: start, $lte: end } });
  const sessionsHeld = logs.length;

  // average attendance % across sessions
  let attPct = null;
  if (sessionsHeld) {
    let present = 0, total = 0;
    for (const log of logs) {
      for (const a of log.attendance) { total++; if (a.present) present++; }
    }
    attPct = total ? Math.round((present / total) * 100) : 0;
  }

  const plan = await Plan.findOne({ batch: cycle.batch });
  const topicsPlanned   = plan ? plan.topics.length : 0;
  const topicsCompleted = plan ? plan.topics.filter(t => t.status === 'done').length : 0;

  const toppers = await Topper.find({ batch: cycle.batch }).populate('student', 'name roll');
  // toppers store a cycle label; match by number if present, else take all for the batch
  const top3 = toppers
    .filter(t => !t.cycle || t.cycle.toString().includes(String(cycle.number)))
    .sort((a,b) => a.rank - b.rank)
    .slice(0, 3)
    .map(t => ({ rank: t.rank, name: t.student?.name || '', roll: t.student?.roll || '' }));

  const totalStudents = await Student.countDocuments({ batch: cycle.batch });

  return { avgAttendance: attPct, sessionsHeld, topicsPlanned, topicsCompleted, top3, totalStudents };
}

// GET /api/cycles/halloffame?semester=ID  (PUBLIC) — cycles that have top-3, newest first
// Shape for the public page: grouped client-side as Cycle -> Batch -> top3
router.get('/halloffame', async (req, res) => {
  try {
    const filter = { 'report.top3.0': { $exists: true } }; // has at least one top3 entry
    if (req.query.semester) filter.semester = req.query.semester;
    const cycles = await Cycle.find(filter)
      .populate('batch', 'name track')
      .sort('-startDate');
    const out = cycles.map(c => ({
      _id: c._id, number: c.number, name: c.name,
      startDate: c.startDate, endDate: c.endDate,
      batch: c.batch ? { _id: c.batch._id, name: c.batch.name, track: c.batch.track } : null,
      top3: (c.report.top3 || []).sort((a,b)=>a.rank-b.rank).map(t => ({
        rank: t.rank, name: t.name, roll: t.roll, github: t.github,
        photo: t.photo?.data ? `data:${t.photo.contentType};base64,${t.photo.data}` : null,
      })),
    }));
    res.json({ cycles: out });
  } catch (err) { res.status(500).json({ message: err.message }); }
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
    const cycles = await Cycle.find(filter)
      .populate('batch', 'name track trainers')
      .sort('-startDate');
    res.json({ cycles });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/cycles/next-number?batch=ID  — suggest the next per-batch number
router.get('/next-number', protect, async (req, res) => {
  try {
    const last = await Cycle.findOne({ batch: req.query.batch }).sort('-number');
    res.json({ next: last ? last.number + 1 : 1 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/cycles/:id  — includes live data if open, snapshot if closed
router.get('/:id', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.id).populate('batch', 'name track trainers');
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    let live = null;
    if (cycle.status !== 'closed') live = await computeLiveData(cycle);
    res.json({ cycle, live });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/cycles/bulk  (admin) — create a cycle on the same dates for several batches.
// Each batch gets its OWN per-batch number. Batches with a date overlap are skipped.
router.post('/bulk', protect, superadminOnly, async (req, res) => {
  try {
    const { batches, name, startDate, endDate } = req.body;
    if (!Array.isArray(batches) || !batches.length || !startDate || !endDate)
      return res.status(400).json({ message: 'Batches, start and end dates required' });

    const s = dayKey(startDate), e = dayKey(endDate);
    if (e < s) return res.status(400).json({ message: 'End date is before start date' });

    const created = [], skipped = [];
    for (const batchId of batches) {
      const batchDoc = await Batch.findById(batchId);
      if (!batchDoc) { skipped.push({ batchId, reason: 'batch not found' }); continue; }

      const overlap = await Cycle.findOne({ batch: batchId, startDate: { $lte: e }, endDate: { $gte: s } });
      if (overlap) { skipped.push({ batchId, name: batchDoc.name, reason: `overlaps Cycle ${overlap.number}` }); continue; }

      const last = await Cycle.findOne({ batch: batchId }).sort('-number');
      const num = last ? last.number + 1 : 1;
      try {
        const c = await Cycle.create({
          batch: batchId, semester: batchDoc.semester, number: num, name: name || '',
          startDate: s, endDate: e, createdBy: req.user._id,
        });
        created.push({ batchId, name: batchDoc.name, number: num, cycleId: c._id });
      } catch (err) {
        skipped.push({ batchId, name: batchDoc.name, reason: 'could not create' });
      }
    }
    res.status(201).json({ created, skipped, createdCount: created.length, skippedCount: skipped.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/cycles  (admin) — create a cycle; enforce non-overlapping dates per batch
router.post('/', protect, superadminOnly, async (req, res) => {
  try {
    const { batch, number, name, startDate, endDate } = req.body;
    if (!batch || !startDate || !endDate)
      return res.status(400).json({ message: 'Batch, start and end dates required' });
    const batchDoc = await Batch.findById(batch);
    if (!batchDoc) return res.status(404).json({ message: 'Batch not found' });

    const s = dayKey(startDate), e = dayKey(endDate);
    if (e < s) return res.status(400).json({ message: 'End date is before start date' });

    // overlap check within the same batch
    const overlap = await Cycle.findOne({
      batch,
      startDate: { $lte: e },
      endDate:   { $gte: s },
    });
    if (overlap)
      return res.status(400).json({ message: `Dates overlap with Cycle ${overlap.number} in this batch.` });

    let num = number;
    if (!num) {
      const last = await Cycle.findOne({ batch }).sort('-number');
      num = last ? last.number + 1 : 1;
    }

    const cycle = await Cycle.create({
      batch, semester: batchDoc.semester, number: num, name: name || '',
      startDate: s, endDate: e, createdBy: req.user._id,
    });
    res.status(201).json({ cycle });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ message: 'That cycle number already exists for this batch.' });
    res.status(500).json({ message: err.message });
  }
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
    if (!r.top3 || !r.top3.length) r.top3 = live.top3;
    if (r.totalStudents == null)   r.totalStudents = live.totalStudents;
    cycle.status = 'closed';
    cycle.closedAt = new Date();
    await cycle.save();
    res.json({ cycle });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/cycles/:id/report  — trainer (of the batch) or admin saves the report
router.put('/:id/report', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.id);
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    if (!(await canAccessBatch(req.user, cycle.batch)))
      return res.status(403).json({ message: 'Not your batch' });
    if (cycle.status === 'closed')
      return res.status(400).json({ message: 'This cycle is closed. Ask admin to reopen it.' });
    if (cycle.status !== 'report-open' && req.user.role !== 'superadmin')
      return res.status(400).json({ message: 'The report is not open yet.' });

    const allowed = [
      'avgAttendance','sessionsHeld','topicsPlanned','topicsCompleted',
      'syllabusCoverage','coverageNote','submittedCount','totalStudents',
      'performanceRating','trainerConfidence','problemsFaced','improvementNeeded',
      'standoutStudents','strugglingStudents','topicsNotCovered','reflection',
      'projectTitle','projectNote',
    ];
    for (const k of allowed) if (k in req.body) cycle.report[k] = req.body[k];

    // top3: sanitize photos (accept data-URL, store as {data,contentType}); cap 2MB each
    if (Array.isArray(req.body.top3)) {
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
    }

    cycle.report.submitted = true;
    cycle.report.submittedBy = req.user._id;
    cycle.report.submittedAt = new Date();
    await cycle.save();
    res.json({ cycle });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/cycles/:id  (admin)
router.delete('/:id', protect, superadminOnly, async (req, res) => {
  try {
    await Cycle.findByIdAndDelete(req.params.id);
    res.json({ message: 'Cycle deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
