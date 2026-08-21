const express  = require('express');
const DailyLog = require('../models/DailyLog');
const Plan     = require('../models/Plan');
const Batch    = require('../models/Batch');
const Student  = require('../models/Student');
const Semester = require('../models/Semester');
const { protect, canAccessBatch } = require('../middleware/auth');
const router   = express.Router();

function dayKey(d) {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

// Recompute a student's presentCount/totalSessions from all logs of their batch
async function recomputeBatchStats(batchId) {
  const logs = await DailyLog.find({ batch: batchId });
  const totalSessions = logs.length;
  const presentMap = {}; // studentId -> present count
  for (const log of logs) {
    for (const a of log.attendance) {
      const id = a.student.toString();
      presentMap[id] = (presentMap[id] || 0) + (a.present ? 1 : 0);
    }
  }
  const students = await Student.find({ batch: batchId });
  for (const s of students) {
    s.stats.totalSessions = totalSessions;
    s.stats.presentCount  = presentMap[s._id.toString()] || 0;
    await s.save();
  }
}

// GET /api/logs?batch=ID   or   ?semester=ID   (recent logs)
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.query.batch)    filter.batch = req.query.batch;
    if (req.query.semester) filter.semester = req.query.semester;
    const logs = await DailyLog.find(filter)
      .populate('batch', 'name')
      .populate('loggedBy', 'name')
      .sort('-date')
      .limit(parseInt(req.query.limit) || 100);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/logs/oversight  — superadmin morning dashboard
// Returns, per active-semester batch: last log date, logged-today flag, plan completion %
router.get('/oversight', protect, async (req, res) => {
  try {
    const active = await Semester.findOne({ status: 'active' });
    if (!active) return res.json({ semester: null, rows: [] });

    const batches = await Batch.find({ semester: active._id }).populate('trainers', 'name');
    const today = dayKey(new Date());

    const rows = [];
    for (const b of batches) {
      const lastLog = await DailyLog.findOne({ batch: b._id }).sort('-date');
      const loggedToday = lastLog && dayKey(lastLog.date).getTime() === today.getTime();
      const plan = await Plan.findOne({ batch: b._id });
      const totalTopics = plan ? plan.topics.length : 0;
      const doneTopics  = plan ? plan.topics.filter(t => t.status === 'done').length : 0;
      const nextTopic   = plan ? (plan.topics.find(t => t.status !== 'done')?.title || '— plan complete —') : '— no plan —';
      const studentCount = await Student.countDocuments({ batch: b._id });
      rows.push({
        batchId: b._id, batchName: b.name, track: b.track,
        trainers: b.trainers.map(t => t.name),
        lastLogDate: lastLog ? lastLog.date : null,
        loggedToday,
        planPct: totalTopics ? Math.round((doneTopics / totalTopics) * 100) : 0,
        doneTopics, totalTopics, nextTopic,
        studentCount,
      });
    }
    res.json({ semester: { _id: active._id, name: active.name }, rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/logs/one?batch=ID&date=YYYY-MM-DD  — fetch a specific day's log (for editing)
router.get('/one', protect, async (req, res) => {
  try {
    const { batch, date } = req.query;
    const log = await DailyLog.findOne({ batch, date: dayKey(date) });
    res.json({ log: log || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/logs  — create or update the day's log (upsert per batch+date)
// body: { batch, date, topicsCovered:[topicId], status, notes, prepLink, attendance:[{student,present}] }
router.post('/', protect, async (req, res) => {
  try {
    const { batch, date, topicsCovered, status, notes, prepLink, attendance } = req.body;
    if (!batch || !date) return res.status(400).json({ message: 'Batch and date required' });
    if (!(await canAccessBatch(req.user, batch)))
      return res.status(403).json({ message: 'Not your batch' });

    const batchDoc = await Batch.findById(batch);
    if (!batchDoc) return res.status(404).json({ message: 'Batch not found' });

    const d = dayKey(date);
    const update = {
      batch, semester: batchDoc.semester, date: d, loggedBy: req.user._id,
      topicsCovered: topicsCovered || [],
      status: status || 'done',
      notes: notes || '', prepLink: prepLink || '',
      attendance: attendance || [],
    };
    const log = await DailyLog.findOneAndUpdate(
      { batch, date: d }, update, { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // Tick off covered topics in the plan (mark done if status=done, in-progress if partial)
    if (topicsCovered && topicsCovered.length) {
      const plan = await Plan.findOne({ batch });
      if (plan) {
        for (const tid of topicsCovered) {
          const topic = plan.topics.id(tid);
          if (topic) {
            if (status === 'done') { topic.status = 'done'; topic.completedOn = d; }
            else if (status === 'partial' && topic.status !== 'done') topic.status = 'in-progress';
          }
        }
        await plan.save();
      }
    }

    // Recompute attendance stats for the batch's students
    await recomputeBatchStats(batch);

    res.status(201).json({ log });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/logs/:id  (superadmin or batch trainer)
router.delete('/:id', protect, async (req, res) => {
  try {
    const log = await DailyLog.findById(req.params.id);
    if (!log) return res.status(404).json({ message: 'Log not found' });
    if (!(await canAccessBatch(req.user, log.batch)))
      return res.status(403).json({ message: 'Not your batch' });
    const batchId = log.batch;
    await DailyLog.findByIdAndDelete(req.params.id);
    await recomputeBatchStats(batchId);
    res.json({ message: 'Log deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
