// ─────────────────────────────────────────────────────────────────────
//  /api/toppers — a batch's Top 3, cycle by cycle (staff, batch page).
//  The ONE source is each cycle's report.top3, filled automatically from the
//  marks (services/topThree.js) — the same data the public Hall of Fame shows.
//  Entries typed by hand in the old "Add topper" form (Topper collection)
//  are still listed, read-only, under "older entries".
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const Cycle   = require('../models/Cycle');
const Topper  = require('../models/Topper');
const perf    = require('../services/performance');
const { protect, canAccessBatch } = require('../middleware/auth');
const router  = express.Router();

// GET /api/toppers?batch=ID
router.get('/', protect, async (req, res) => {
  try {
    const batch = req.query.batch;
    if (!batch) return res.status(400).json({ message: 'batch required' });
    if (!(await canAccessBatch(req.user, batch))) return res.status(403).json({ message: 'Not your batch' });
    const [cycles, legacy] = await Promise.all([
      Cycle.find({ batch }).select('number name startDate endDate status track.projectDate track.marks report.top3Manual report.top3.rank report.top3.student report.top3.name report.top3.roll report.top3.github report.top3.photo.contentType')
        .sort('-startDate').lean(),
      Topper.find({ batch }).populate('student', 'name roll').sort({ cycle: 1, rank: 1 }).lean(),
    ]);
    res.json({
      cycles: cycles.map(c => ({
        _id: c._id, number: c.number, name: c.name || '', status: c.status,
        start: perf.dayYmd(c.startDate), end: perf.dayYmd(c.endDate),
        projectDay: perf.dayYmd(c.track?.projectDate || c.endDate),
        marksDone: !!c.track?.marks?.at, manual: !!c.report?.top3Manual,
        top3: (c.report?.top3 || []).sort((a, b) => a.rank - b.rank)
          .map(t => ({ rank: t.rank, student: t.student, name: t.name, roll: t.roll, github: t.github || '', hasPhoto: !!t.photo?.contentType })),
      })),
      legacy: legacy.map(t => ({ _id: t._id, rank: t.rank, cycle: t.cycle, project: t.project, name: t.student?.name || '— deleted student —', roll: t.student?.roll || '' })),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
