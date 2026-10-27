// ─────────────────────────────────────────────────────────────────────
//  /api/feedback — trainer feedback from students (replaces the Google Form).
//  The admin opens a window for some batches; students rate each of their
//  trainers once. Anonymous: no student is ever shown. Trainers see only their
//  own averages, and only once 5 or more students have answered; the admin
//  also sees the written comments (without names).
// ─────────────────────────────────────────────────────────────────────
const express  = require('express');
const mongoose = require('mongoose');
const Batch    = require('../models/Batch');
const Semester = require('../models/Semester');
const Student  = require('../models/Student');
const { FeedbackWindow, Feedback, QUESTIONS } = require('../models/Feedback');
const { protect, superadminOnly, seesAll } = require('../middleware/auth');
const sv       = require('../services/studentView');
const router   = express.Router();
const MIN_FOR_TRAINER = 5;

// admin and management see every batch (management cannot write: middleware/auth.js)
const isAdmin = seesAll;

// GET /api/feedback/windows
router.get('/windows', protect, async (req, res) => {
  try {
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) return res.json({ windows: [], questions: [] });
    let filter = { semester: sem._id };
    if (!isAdmin(req.user)) {
      const mine = await Batch.find({ trainers: req.user._id }).select('_id');
      filter.batches = { $in: mine.map(b => b._id) };
    }
    const ws = await FeedbackWindow.find(filter).sort('-openFrom').populate('batches', 'name').lean();
    const now = new Date();
    const out = [];
    for (const w of ws) {
      const count = await Feedback.countDocuments({ window: w._id });
      out.push({ _id: w._id, title: w.title, openFrom: w.openFrom, openUntil: w.openUntil,
        open: now >= w.openFrom && now <= w.openUntil, batches: w.batches.map(b => ({ _id: b._id, name: b.name })), responses: count });
    }
    res.json({ windows: out, questions: QUESTIONS.map(([key, text]) => ({ key, text })), minForTrainer: MIN_FOR_TRAINER, isAdmin: isAdmin(req.user) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/feedback/windows (admin) { title, batchIds: [], hours }
router.post('/windows', protect, superadminOnly, async (req, res) => {
  try {
    const sem = await Semester.findOne({ status: 'active' });
    const ids = (req.body.batchIds || []).filter(x => mongoose.isValidObjectId(x));
    if (!ids.length) return res.status(400).json({ message: 'Choose at least one batch.' });
    const hours = Math.min(24 * 14, Math.max(1, Number(req.body.hours) || 48));
    const now = new Date();
    const w = await FeedbackWindow.create({ semester: sem._id, title: String(req.body.title || 'Trainer feedback').slice(0, 100),
      batches: ids, openFrom: now, openUntil: new Date(now.getTime() + hours * 3600e3), createdBy: req.user._id });
    res.status(201).json({ window: w });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/feedback/windows/:id (admin) { close: true } or { hours } (extend from now)
router.patch('/windows/:id', protect, superadminOnly, async (req, res) => {
  try {
    const w = await FeedbackWindow.findById(req.params.id);
    if (!w) return res.status(404).json({ message: 'Not found' });
    if (req.body.close) w.openUntil = new Date();
    else if (req.body.hours) w.openUntil = new Date(Date.now() + Math.min(24 * 14, Number(req.body.hours)) * 3600e3);
    await w.save();
    res.json({ ok: true, openUntil: w.openUntil });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/feedback/windows/:id/results
router.get('/windows/:id/results', protect, async (req, res) => {
  try {
    const w = await FeedbackWindow.findById(req.params.id).populate('batches', 'name trainers').lean();
    if (!w) return res.status(404).json({ message: 'Not found' });
    const admin = isAdmin(req.user);
    if (!admin && !w.batches.some(b => (b.trainers || []).some(t => String(t) === String(req.user._id))))
      return res.status(403).json({ message: 'Not your batch' });
    const all = await Feedback.find({ window: w._id }).populate('trainer', 'name').lean();
    const rows = [];
    for (const b of w.batches) {
      const trainers = await sv.ratableTrainers(b._id);
      const students = await Student.countDocuments({ batch: b._id });
      for (const t of trainers) {
        if (!admin && String(t._id) !== String(req.user._id)) continue;
        const list = all.filter(f => String(f.batch) === String(b._id) && String(f.trainer?._id) === String(t._id));
        const n = list.length;
        const row = { batch: b.name, batchId: b._id, trainer: t.name, trainerId: t._id, responses: n, students };
        if (n && (admin || n >= MIN_FOR_TRAINER)) {
          row.averages = Object.fromEntries(QUESTIONS.map(([k]) => [k, Math.round(10 * list.reduce((a, f) => a + f.ratings[k], 0) / n) / 10]));
          row.overall = Math.round(10 * Object.values(row.averages).reduce((a, x) => a + x, 0) / QUESTIONS.length) / 10;
          if (admin) row.comments = list.map(f => f.comment).filter(Boolean).sort();
        } else row.hidden = n > 0 && !admin;
        rows.push(row);
      }
    }
    res.json({ window: { _id: w._id, title: w.title, openFrom: w.openFrom, openUntil: w.openUntil },
      questions: QUESTIONS.map(([key, text]) => ({ key, text })), minForTrainer: MIN_FOR_TRAINER, rows, isAdmin: admin });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
