const express  = require('express');
const DailyLog = require('../models/DailyLog');
const Plan     = require('../models/Plan');
const Batch    = require('../models/Batch');
const Student  = require('../models/Student');
const Semester = require('../models/Semester');
const { protect, canAccessBatch, noCotrainer } = require('../middleware/auth');
const router   = express.Router();

function dayKey(d) {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

// Sessions that count towards attendance: logs where the roll call was actually
// taken. Logs written before this field existed are treated as counted when
// they carry attendance entries, so historical numbers don't move.
const countsForAttendance = (log) =>
  log.attendanceTaken || (Array.isArray(log.attendance) && log.attendance.length > 0);

// Recompute presentCount/totalSessions for every student in a batch.
// One bulkWrite instead of one save() per student — this used to fire 145
// sequential writes every time a trainer saved a daily log.
async function recomputeBatchStats(batchId) {
  const logs = (await DailyLog.find({ batch: batchId })).filter(countsForAttendance);
  const totalSessions = logs.length;
  const presentMap = {}; // studentId -> present count
  for (const log of logs) {
    for (const a of log.attendance) {
      const id = a.student.toString();
      presentMap[id] = (presentMap[id] || 0) + (a.present ? 1 : 0);
    }
  }
  const students = await Student.find({ batch: batchId }).select('_id');
  if (!students.length) return;
  await Student.bulkWrite(students.map(s => ({
    updateOne: {
      filter: { _id: s._id },
      update: { $set: {
        'stats.totalSessions': totalSessions,
        'stats.presentCount':  presentMap[s._id.toString()] || 0,
      } },
    },
  })));
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

    // Superadmin sees every batch; a trainer/co-trainer sees only their own.
    const batchFilter = { semester: active._id };
    if (req.user.role !== 'superadmin') batchFilter.trainers = req.user._id;
    const batches = await Batch.find(batchFilter).populate('trainers', 'name');
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
    const existing = await DailyLog.findOne({ batch, date: d });

    // Merge attendance instead of replacing it. Two trainers share some batches;
    // the old code let whoever saved second wipe the other's roll call.
    const incoming = Array.isArray(attendance) ? attendance : [];
    const merged = new Map();
    if (existing) for (const a of existing.attendance) merged.set(a.student.toString(), !!a.present);
    for (const a of incoming) if (a && a.student) merged.set(a.student.toString(), !!a.present);

    const contributors = new Set((existing?.contributors || []).map(String));
    contributors.add(req.user._id.toString());

    const update = {
      batch, semester: batchDoc.semester, date: d, loggedBy: req.user._id,
      topicsCovered: topicsCovered || [],
      status: status || 'done',
      notes: notes || '', prepLink: prepLink || '',
      attendance: [...merged].map(([student, present]) => ({ student, present })),
      // Sticks once true: a later save that carries no attendance can't undo it.
      attendanceTaken: incoming.length > 0 || !!existing?.attendanceTaken,
      contributors: [...contributors],
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

// DELETE /api/logs/:id  (superadmin or batch trainer — not co-trainers)
router.delete('/:id', protect, noCotrainer, async (req, res) => {
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

// Exported for tests — pure helper, no database involved.
router.__test = { countsForAttendance };

module.exports = router;
