const express = require('express');
const Plan    = require('../models/Plan');
const Batch   = require('../models/Batch');
const { protect, canAccessBatch } = require('../middleware/auth');
const router  = express.Router();

// GET /api/plans/:batchId  (staff only)
router.get('/:batchId', protect, async (req, res) => {
  try {
    let plan = await Plan.findOne({ batch: req.params.batchId });
    res.json({ plan: plan || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/plans/:batchId  — replace whole topic list (used by the plan editor)
// body: { topics: [{title, order, status?}] }
router.put('/:batchId', protect, async (req, res) => {
  try {
    if (!(await canAccessBatch(req.user, req.params.batchId)))
      return res.status(403).json({ message: 'Not your batch' });
    const batch = await Batch.findById(req.params.batchId);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });

    const topics = (req.body.topics || []).map((t, i) => ({
      _id: t._id, // keep existing ids where present
      title: t.title,
      order: t.order != null ? t.order : i,
      status: t.status || 'pending',
      completedOn: t.completedOn || null,
    }));

    let plan = await Plan.findOne({ batch: req.params.batchId });
    if (!plan) {
      plan = await Plan.create({ batch: batch._id, semester: batch.semester, topics, updatedBy: req.user._id });
    } else {
      plan.topics = topics;
      plan.updatedBy = req.user._id;
      await plan.save();
    }
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/plans/:batchId/topic/:topicId  — quick status change
router.patch('/:batchId/topic/:topicId', protect, async (req, res) => {
  try {
    if (!(await canAccessBatch(req.user, req.params.batchId)))
      return res.status(403).json({ message: 'Not your batch' });
    const plan = await Plan.findOne({ batch: req.params.batchId });
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    const topic = plan.topics.id(req.params.topicId);
    if (!topic) return res.status(404).json({ message: 'Topic not found' });
    if (req.body.status) {
      topic.status = req.body.status;
      topic.completedOn = req.body.status === 'done' ? new Date() : null;
    }
    await plan.save();
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
