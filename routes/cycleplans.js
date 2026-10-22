const express   = require('express');
const CyclePlan = require('../models/CyclePlan');
const Cycle     = require('../models/Cycle');
const Batch     = require('../models/Batch');
const { protect, canAccessBatch } = require('../middleware/auth');
const perf = require('../services/performance');
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

    const incoming = Array.isArray(inputClasses) ? inputClasses : [];
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
    res.json({ planned, cycle: { _id: cycle._id, number: cycle.number } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Shared with the MCP write tools (mcp/writeTools.js).
router.__shared = { saveCyclePlan };

module.exports = router;
