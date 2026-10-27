const express = require('express');
const Batch   = require('../models/Batch');
const Plan    = require('../models/Plan');
const Student = require('../models/Student');
const Semester= require('../models/Semester');
const User    = require('../models/User');
const tenant  = require('../services/tenant');
const { protect, superadminOnly, seesAll } = require('../middleware/auth');
const router  = express.Router();

// GET /api/batches?semester=ID   (staff only — the public page uses /cycles/halloffame)
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.query.semester) filter.semester = req.query.semester;
    const batches = await Batch.find(filter)
      .populate('trainers', 'name email role')
      .populate('semester', 'name status')
      .sort('name').lean();
    res.json({ batches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/batches/mine  (batches the logged-in user is assigned to, current active semester)
router.get('/mine', protect, async (req, res) => {
  try {
    const active = await Semester.findOne({ status: 'active' });
    const filter = {};
    if (active) filter.semester = active._id;
    if (!seesAll(req.user)) filter.trainers = req.user._id;
    const batches = await Batch.find(filter)
      .populate('trainers', 'name email role')
      .populate('semester', 'name status')
      .sort('name').lean();
    res.json({ batches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/batches/:id
router.get('/:id', protect, async (req, res) => {
  try {
    if (!require('mongoose').isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Batch not found' });
    const [batch, studentCount] = await Promise.all([
      Batch.findById(req.params.id).populate('trainers', 'name email role').populate('semester', 'name status').lean(),
      Student.countDocuments({ batch: req.params.id }),
    ]);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    res.json({ batch, studentCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Trainers must be staff of this college, and the semester this college's.
async function checkRefs({ trainers, semester }) {
  if (semester !== undefined && !(await Semester.exists({ _id: semester }))) return 'Semester not found';
  if (trainers !== undefined) {
    const ids = [...new Set((trainers || []).map(String))];
    if (ids.some(id => !/^[a-f0-9]{24}$/i.test(id))) return 'Bad trainer id';
    const n = await User.countDocuments({ _id: { $in: ids }, ...User.inOrg(tenant.currentOrg()) });
    if (n !== ids.length) return 'A trainer is not on this college\'s staff';
  }
  return null;
}

// POST /api/batches  (superadmin) — create a batch; optionally seed plan from another batch
router.post('/', protect, superadminOnly, async (req, res) => {
  try {
    const { name, semester, composition, track, trainers, copyPlanFrom } = req.body;
    if (!name || !semester)
      return res.status(400).json({ message: 'Name and semester required' });
    const bad = await checkRefs({ trainers, semester });
    if (bad) return res.status(400).json({ message: bad });

    const batch = await Batch.create({
      name, semester, composition: composition || '', track: track || '',
      trainers: trainers || [], createdBy: req.user._id,
    });

    // Create an empty plan (or copy topics from another batch's plan)
    let topics = [];
    if (copyPlanFrom) {
      const src = await Plan.findOne({ batch: copyPlanFrom });
      if (src) topics = src.topics.map(t => ({ title: t.title, order: t.order, status: 'pending' }));
    }
    await Plan.create({ batch: batch._id, semester, topics, updatedBy: req.user._id });

    const populated = await Batch.findById(batch._id).populate('trainers', 'name email role');
    res.status(201).json({ batch: populated });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ message: 'A batch with that name already exists in this semester.' });
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/batches/:id  (superadmin) — edit / assign trainers
router.patch('/:id', protect, superadminOnly, async (req, res) => {
  try {
    const { name, composition, track, trainers, isActive } = req.body;
    const bad = await checkRefs({ trainers });
    if (bad) return res.status(400).json({ message: bad });
    const batch = await Batch.findByIdAndUpdate(
      req.params.id,
      { ...(name !== undefined && { name }),
        ...(composition !== undefined && { composition }),
        ...(track !== undefined && { track }),
        ...(trainers !== undefined && { trainers }),
        ...(isActive !== undefined && { isActive }) },
      { new: true }
    ).populate('trainers', 'name email role');
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    res.json({ batch });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/batches/:id  (superadmin)
// Removes the batch and EVERYTHING that points at it. Cycles, cycle marks and
// cycle plans used to survive here and were left dangling at a batch that no
// longer existed.
router.delete('/:id', protect, superadminOnly, async (req, res) => {
  try {
    const Topper    = require('../models/Topper');
    const DailyLog  = require('../models/DailyLog');
    const Cycle     = require('../models/Cycle');
    const CycleMark = require('../models/CycleMark');
    const CyclePlan = require('../models/CyclePlan');
    const id = req.params.id;

    await Plan.deleteOne({ batch: id });
    await Student.deleteMany({ batch: id });
    await DailyLog.deleteMany({ batch: id });
    await Topper.deleteMany({ batch: id });
    await CycleMark.deleteMany({ batch: id });
    await CyclePlan.deleteMany({ batch: id });
    await Cycle.deleteMany({ batch: id });
    await Batch.findByIdAndDelete(id);
    res.json({ message: 'Batch and all its data deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/batches/:id/roster-lock  (admin) — finalise/unfinalise the roster
router.patch('/:id/roster-lock', protect, superadminOnly, async (req, res) => {
  try {
    const { locked } = req.body;
    const batch = await Batch.findByIdAndUpdate(
      req.params.id,
      { rosterLocked: !!locked, rosterLockedAt: locked ? new Date() : null },
      { new: true }
    );
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    res.json({ batch });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
