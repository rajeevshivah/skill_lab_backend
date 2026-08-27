const express  = require('express');
const Student  = require('../models/Student');
const Batch    = require('../models/Batch');
const Cycle    = require('../models/Cycle');
const { protect } = require('../middleware/auth');
const router   = express.Router();

// GET /api/search?q=term  — searches students, batches, cycles.
// Trainers are scoped to their own batches; superadmin sees everything.
router.get('/', protect, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ students: [], batches: [], cycles: [] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // determine which batches this user may see
    let batchScope = null; // null = all
    if (req.user.role !== 'superadmin') {
      const mine = await Batch.find({ trainers: req.user._id }).select('_id');
      batchScope = mine.map(b => b._id);
    }

    const batchFilter = batchScope ? { _id: { $in: batchScope } } : {};
    const inScope     = batchScope ? { batch: { $in: batchScope } } : {};

    const [students, batches, cycles] = await Promise.all([
      Student.find({ ...inScope, $or: [{ name: rx }, { roll: rx }] })
        .select('name roll batch').populate('batch', 'name').limit(15),
      Batch.find({ ...batchFilter, $or: [{ name: rx }, { track: rx }] })
        .select('name track').limit(10),
      Cycle.find({ ...inScope, $or: [{ name: rx }] })
        .select('number name batch').populate('batch', 'name').limit(10),
    ]);

    res.json({
      students: students.map(s => ({ _id: s._id, name: s.name, roll: s.roll, batch: s.batch?.name, batchId: s.batch?._id })),
      batches:  batches.map(b => ({ _id: b._id, name: b.name, track: b.track })),
      cycles:   cycles.map(c => ({ _id: c._id, number: c.number, name: c.name, batch: c.batch?.name })),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
