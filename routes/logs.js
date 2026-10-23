const express  = require('express');
const DailyLog = require('../models/DailyLog');
const Plan     = require('../models/Plan');
const Batch    = require('../models/Batch');
const Student  = require('../models/Student');
const Semester = require('../models/Semester');
const { protect, canAccessBatch, noCotrainer } = require('../middleware/auth');
const Cycle     = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const { isComplete, GITHUB } = require('../services/logRule');
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

    // All batches at once: plans and student counts in bulk, last log dates in parallel.
    const ids = batches.map(b => b._id);
    const [plans, counts, lastLogs] = await Promise.all([
      Plan.find({ batch: { $in: ids } }).select('batch topics.title topics.status').lean(),
      Student.aggregate([{ $match: { batch: { $in: ids } } }, { $group: { _id: '$batch', n: { $sum: 1 } } }]),
      // last log per batch: tiny index lookups sent together (one wait, not one per batch)
      Promise.all(ids.map(id => DailyLog.findOne({ batch: id }).sort('-date').select('batch date').lean())),
    ]);
    const planOf = new Map(plans.map(p => [String(p.batch), p]));
    const countOf = new Map(counts.map(c => [String(c._id), c.n]));
    const lastOf = new Map(lastLogs.filter(Boolean).map(x => [String(x.batch), x]));
    const rows = batches.map((b) => {
      const lastLog = lastOf.get(String(b._id)) || null;
      const loggedToday = !!lastLog && dayKey(lastLog.date).getTime() === today.getTime();
      const plan = planOf.get(String(b._id));
      const totalTopics = plan ? plan.topics.length : 0;
      const doneTopics  = plan ? plan.topics.filter(t => t.status === 'done').length : 0;
      const nextTopic   = plan ? (plan.topics.find(t => t.status !== 'done')?.title || '— plan complete —') : '— no plan —';
      return {
        batchId: b._id, batchName: b.name, track: b.track,
        trainers: b.trainers.map(t => t.name),
        lastLogDate: lastLog ? lastLog.date : null,
        loggedToday,
        planPct: totalTopics ? Math.round((doneTopics / totalTopics) * 100) : 0,
        doneTopics, totalTopics, nextTopic,
        studentCount: countOf.get(String(b._id)) || 0,
      };
    });
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
    const r = await upsertDailyLog(req.user, req.body);
    res.status(r.status).json(r.body);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// The actual save logic — shared by the route above and the MCP tool
// save_daily_log, so the website and AI apps behave identically.
// Returns { status, body } instead of writing to a response.
async function upsertDailyLog(user, input) {
    const { batch, date, topicsCovered, status, notes, prepLink, attendance } = input;
    if (status === 'no-class' && user.role !== 'superadmin')
      return { status: 403, body: { message: 'Only the admin can mark a day as "no class". Tell the admin if a class was cancelled.' } };
    if (input.github && !GITHUB.includes(input.github))
      return { status: 400, body: { message: 'github must be one of: ' + GITHUB.join(', ') } };
    const req = { user };
    if (!batch || !date) return { status: 400, body: { message: 'Batch and date required' } };
    if (!(await canAccessBatch(req.user, batch)))
      return { status: 403, body: { message: 'Not your batch' } };

    const batchDoc = await Batch.findById(batch);
    if (!batchDoc) return { status: 404, body: { message: 'Batch not found' } };

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

    // Which planned class was this? Given → use it; else keep the saved one;
    // else take the class planned for this date in the cycle plan.
    let planClass = input.planClass !== undefined && input.planClass !== '' ? input.planClass : (existing?.planClass ?? null);
    if (planClass != null) planClass = Number(planClass) || null;
    if (planClass == null && status !== 'no-class') {
      const cyc = await Cycle.findOne({ batch, startDate: { $lte: d }, endDate: { $gte: d } }).select('_id');
      const cp = cyc && await CyclePlan.findOne({ cycle: cyc._id }).select('classes.number classes.date').lean();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const hit = (cp?.classes || []).find(c => c.date === ymd);
      if (hit) planClass = hit.number;
    }
    const github = input.github !== undefined ? (input.github || '') : (existing?.github || '');
    const noClass = status === 'no-class';

    const update = {
      batch, semester: batchDoc.semester, date: d, loggedBy: req.user._id,
      planClass: noClass ? null : planClass, github: noClass ? '' : github,
      topicsCovered: topicsCovered || [],
      status: status || 'done',
      notes: notes || '', prepLink: prepLink || '',
      attendance: noClass ? [] : [...merged].map(([student, present]) => ({ student, present })),
      // Sticks once true: a later save that carries no attendance can't undo it.
      attendanceTaken: noClass ? false : (incoming.length > 0 || !!existing?.attendanceTaken),
      contributors: [...contributors],
    };
    // First moment the log met the logging rule (never moves afterwards)
    update.completeAt = existing?.completeAt || (isComplete(update) ? new Date() : null);
    const log = await DailyLog.findOneAndUpdate(
      { batch, date: d }, { $set: update, $setOnInsert: { firstLoggedBy: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
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

    return { status: 201, body: { log } };
}

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
// Shared with the MCP write tools (mcp/writeTools.js).
router.__shared = { upsertDailyLog };

module.exports = router;
