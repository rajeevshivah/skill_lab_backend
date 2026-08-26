const express   = require('express');
const CyclePlan = require('../models/CyclePlan');
const Cycle     = require('../models/Cycle');
const Batch     = require('../models/Batch');
const { protect, canAccessBatch } = require('../middleware/auth');
const router    = express.Router();

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
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/cycleplans/:cycleId  — save the whole class list
// body: { classes: [{number,title,notes,trainer,date,time}] }
router.put('/:cycleId', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.cycleId);
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    if (!(await canAccessBatch(req.user, cycle.batch)))
      return res.status(403).json({ message: 'Not your batch' });

    const incoming = Array.isArray(req.body.classes) ? req.body.classes : [];
    const classes = incoming.map((c, i) => ({
      number: c.number || i + 1,
      title:  (c.title || '').trim(),
      notes:  (c.notes || '').trim(),
      trainer: c.trainer || null,
      date:   c.date || '',
      time:   c.time || '',
    }));

    const plan = await CyclePlan.findOneAndUpdate(
      { cycle: cycle._id },
      { cycle: cycle._id, batch: cycle.batch, semester: cycle.semester, classes, updatedBy: req.user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('classes.trainer', 'name');

    res.json({ classes: plan.classes });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
