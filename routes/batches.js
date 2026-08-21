const express = require('express');
const Batch   = require('../models/Batch');
const Plan    = require('../models/Plan');
const Student = require('../models/Student');
const Semester= require('../models/Semester');
const { protect, superadminOnly } = require('../middleware/auth');
const router  = express.Router();

// GET /api/batches?semester=ID   (public read for leaderboard; trainers see own)
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.semester) filter.semester = req.query.semester;
    const batches = await Batch.find(filter)
      .populate('trainers', 'name email role')
      .populate('semester', 'name status')
      .sort('name');
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
    if (req.user.role !== 'superadmin') filter.trainers = req.user._id;
    const batches = await Batch.find(filter)
      .populate('trainers', 'name email role')
      .populate('semester', 'name status')
      .sort('name');
    res.json({ batches });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/batches/:id
router.get('/:id', async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id)
      .populate('trainers', 'name email role')
      .populate('semester', 'name status');
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    const studentCount = await Student.countDocuments({ batch: batch._id });
    res.json({ batch, studentCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/batches  (superadmin) — create a batch; optionally seed plan from another batch
router.post('/', protect, superadminOnly, async (req, res) => {
  try {
    const { name, semester, composition, track, trainers, copyPlanFrom } = req.body;
    if (!name || !semester)
      return res.status(400).json({ message: 'Name and semester required' });

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

// DELETE /api/batches/:id  (superadmin) — removes batch, its plan, students, logs
router.delete('/:id', protect, superadminOnly, async (req, res) => {
  try {
    const Topper = require('../models/Topper');
    const DailyLog = require('../models/DailyLog');
    await Plan.deleteOne({ batch: req.params.id });
    await Student.deleteMany({ batch: req.params.id });
    await DailyLog.deleteMany({ batch: req.params.id });
    await Topper.deleteMany({ batch: req.params.id });
    await Batch.findByIdAndDelete(req.params.id);
    res.json({ message: 'Batch and all its data deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
