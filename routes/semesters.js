const express   = require('express');
const Semester  = require('../models/Semester');
const { protect, superadminOnly } = require('../middleware/auth');
const router    = express.Router();

// GET /api/semesters  (public read — needed by public page)
router.get('/', async (req, res) => {
  try {
    const semesters = await Semester.find().sort('-createdAt');
    res.json({ semesters });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/semesters/active  (public)
router.get('/active', async (req, res) => {
  try {
    const active = await Semester.findOne({ status: 'active' }).sort('-createdAt');
    res.json({ semester: active });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/semesters  (superadmin) — "Start New Semester"
// Archives any currently-active semester, then creates a fresh active one.
router.post('/', protect, superadminOnly, async (req, res) => {
  try {
    const { name, startDate, notes } = req.body;
    if (!name) return res.status(400).json({ message: 'Semester name required' });

    await Semester.updateMany({ status: 'active' }, { status: 'archived', endDate: new Date() });

    const semester = await Semester.create({
      name,
      startDate: startDate || Date.now(),
      notes: notes || '',
      status: 'active',
      createdBy: req.user._id,
    });
    res.status(201).json({ semester });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/semesters/:id  (superadmin) — rename / archive / reactivate
router.patch('/:id', protect, superadminOnly, async (req, res) => {
  try {
    const { name, status, notes, endDate } = req.body;
    // If reactivating, archive others first
    if (status === 'active') {
      await Semester.updateMany({ status: 'active' }, { status: 'archived', endDate: new Date() });
    }
    const semester = await Semester.findByIdAndUpdate(
      req.params.id,
      { ...(name !== undefined && { name }),
        ...(status !== undefined && { status }),
        ...(notes !== undefined && { notes }),
        ...(endDate !== undefined && { endDate }) },
      { new: true }
    );
    if (!semester) return res.status(404).json({ message: 'Semester not found' });
    res.json({ semester });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
