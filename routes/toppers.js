const express = require('express');
const Topper  = require('../models/Topper');
const Student = require('../models/Student');
const Batch   = require('../models/Batch');
const { protect, canAccessBatch } = require('../middleware/auth');
const router  = express.Router();

async function recomputeTopperStats(studentId) {
  const count = await Topper.countDocuments({ student: studentId });
  const projects = await Topper.countDocuments({ student: studentId, project: { $ne: '' } });
  await Student.findByIdAndUpdate(studentId, {
    'stats.topperCount': count,
    'stats.projectCount': projects,
  });
}

// GET /api/toppers?semester=ID&batch=ID&cycle=  (public)
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.semester) filter.semester = req.query.semester;
    if (req.query.batch)    filter.batch = req.query.batch;
    if (req.query.cycle)    filter.cycle = req.query.cycle;
    const toppers = await Topper.find(filter)
      .populate('student', 'name roll photo')
      .populate('batch', 'name track')
      .sort({ cycle: 1, rank: 1 });
    // include photo url
    const out = toppers.map(t => ({
      _id: t._id, rank: t.rank, cycle: t.cycle, project: t.project,
      batch: t.batch,
      student: t.student ? {
        _id: t.student._id, name: t.student.name, roll: t.student.roll,
        photo: t.student.photo?.data ? `data:${t.student.photo.contentType};base64,${t.student.photo.data}` : null,
      } : null,
    }));
    res.json({ toppers: out, total: out.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/toppers/cycles?batch=ID
router.get('/meta/cycles', async (req, res) => {
  try {
    const filter = req.query.batch ? { batch: req.query.batch } : {};
    const cycles = await Topper.distinct('cycle', filter);
    res.json({ cycles: cycles.sort() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/toppers
router.post('/', protect, async (req, res) => {
  try {
    const { student, batch, rank, cycle, project } = req.body;
    if (!student || !batch || !rank || !cycle)
      return res.status(400).json({ message: 'student, batch, rank, cycle required' });
    if (!(await canAccessBatch(req.user, batch)))
      return res.status(403).json({ message: 'Not your batch' });
    const batchDoc = await Batch.findById(batch);
    if (!batchDoc) return res.status(404).json({ message: 'Batch not found' });

    const topper = await Topper.create({
      student, batch, semester: batchDoc.semester,
      rank, cycle, project: project || '', addedBy: req.user._id,
    });
    await recomputeTopperStats(student);
    res.status(201).json({ topper });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ message: `Rank ${req.body.rank} already exists for this batch & cycle.` });
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/toppers/:id
router.put('/:id', protect, async (req, res) => {
  try {
    const existing = await Topper.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (!(await canAccessBatch(req.user, existing.batch)))
      return res.status(403).json({ message: 'Not your batch' });
    const oldStudent = existing.student.toString();
    const { student, rank, cycle, project } = req.body;
    if (student !== undefined) existing.student = student;
    if (rank !== undefined)    existing.rank = rank;
    if (cycle !== undefined)   existing.cycle = cycle;
    if (project !== undefined) existing.project = project;
    await existing.save();
    await recomputeTopperStats(existing.student.toString());
    if (oldStudent !== existing.student.toString()) await recomputeTopperStats(oldStudent);
    res.json({ topper: existing });
  } catch (err) {
    if (err.code === 11000)
      return res.status(400).json({ message: 'That rank already exists for this batch & cycle.' });
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/toppers/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    const t = await Topper.findById(req.params.id);
    if (!t) return res.status(404).json({ message: 'Not found' });
    if (req.user.role === 'cotrainer')
      return res.status(403).json({ message: 'Co-trainers cannot delete' });
    if (!(await canAccessBatch(req.user, t.batch)))
      return res.status(403).json({ message: 'Not your batch' });
    const studentId = t.student.toString();
    await Topper.findByIdAndDelete(req.params.id);
    await recomputeTopperStats(studentId);
    res.json({ message: 'Topper removed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
