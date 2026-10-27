const express  = require('express');
const DailyLog = require('../models/DailyLog');
const Plan     = require('../models/Plan');
const Batch    = require('../models/Batch');
const Student  = require('../models/Student');
const Semester = require('../models/Semester');
const { protect, canAccessBatch, noCotrainer, seesAll } = require('../middleware/auth');
const Cycle     = require('../models/Cycle');
const CyclePlan = require('../models/CyclePlan');
const { isComplete, GITHUB } = require('../services/logRule');
const perf = require('../services/performance');
const sv = require('../services/studentView');
const router   = express.Router();

function dayKey(d) {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

// Attendance counters per student: services/attendanceStats.js
const { recomputeBatchStats, countsForAttendance } = require('../services/attendanceStats');

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

// GET /api/logs/oversight  — the "Today" page, per active-semester batch, from its
// CURRENT CYCLE (cycle plan + daily logs + holidays):
//   classToday / holidayToday, loggedToday, classes due so far vs done,
//   past classes with no log at all, next topic.
router.get('/oversight', protect, async (req, res) => {
  try {
    const active = await Semester.findOne({ status: 'active' });
    if (!active) return res.json({ semester: null, rows: [] });

    // Superadmin sees every batch; a trainer/co-trainer sees only their own.
    const batchFilter = { semester: active._id };
    if (!seesAll(req.user)) batchFilter.trainers = req.user._id;
    const batches = await Batch.find(batchFilter).populate('trainers', 'name').lean();
    const ids = batches.map(b => b._id);
    const today = sv.todayIST();
    const [cycles, counts, lastLogs] = await Promise.all([
      Cycle.find({ batch: { $in: ids } }).select('batch number startDate endDate').sort('startDate').lean(),
      Student.aggregate([{ $match: { batch: { $in: ids } } }, { $group: { _id: '$batch', n: { $sum: 1 } } }]),
      // last log per batch: tiny index lookups sent together (one wait, not one per batch)
      Promise.all(ids.map(id => DailyLog.findOne({ batch: id }).sort('-date').select('batch date').lean())),
    ]);
    // current cycle per batch: the one running today, else the next, else the latest
    const cur = new Map();
    for (const b of ids) {
      const mine = cycles.filter(c => String(c.batch) === String(b));
      cur.set(String(b), mine.find(c => perf.dayYmd(c.startDate) <= today && perf.dayYmd(c.endDate) >= today)
        || mine.find(c => perf.dayYmd(c.startDate) > today) || mine[mine.length - 1] || null);
    }
    const live = [...cur.values()].filter(Boolean);
    const from = live.reduce((m, c) => (perf.dayYmd(c.startDate) < m ? perf.dayYmd(c.startDate) : m), today);
    const to = live.reduce((m, c) => (perf.dayYmd(c.endDate) > m ? perf.dayYmd(c.endDate) : m), today);
    const [plans, logs, holOf] = await Promise.all([
      CyclePlan.find({ cycle: { $in: live.map(c => c._id) } }).select('cycle classes.number classes.title classes.date').lean(),
      live.length ? DailyLog.find({ batch: { $in: ids }, date: { $gte: perf.ymdToDay(from), $lte: perf.ymdToDay(to) } }).select('batch date status').lean() : [],
      sv.holidayFinder(from, to),
    ]);
    const planOf = new Map(plans.map(p => [String(p.cycle), p]));
    const countOf = new Map(counts.map(c => [String(c._id), c.n]));
    const lastOf = new Map(lastLogs.filter(Boolean).map(x => [String(x.batch), x]));
    const rows = batches.map((b) => {
      const c = cur.get(String(b._id));
      const logBy = new Map(logs.filter(l => String(l.batch) === String(b._id)).map(l => [perf.dayYmd(l.date), l]));
      const classes = (c && planOf.get(String(c._id))?.classes || [])
        .filter(k => k.date && k.date >= perf.dayYmd(c.startDate) && k.date <= perf.dayYmd(c.endDate) && !holOf(b._id, k.date))
        .sort((x, y) => x.date.localeCompare(y.date) || x.number - y.number);
      const k0 = classes.find(k => k.date === today);
      const loggedToday = logBy.has(today);
      const due = classes.filter(k => k.date < today || (k.date === today && loggedToday));
      const done = due.filter(k => logBy.get(k.date)?.status === 'done').length;
      const notLoggedDays = classes.filter(k => k.date < today && !logBy.has(k.date)).length;
      const next = (!loggedToday && k0) || classes.find(k => k.date > today);
      const lastLog = lastOf.get(String(b._id)) || null;
      return {
        batchId: b._id, batchName: b.name, track: b.track,
        trainers: (b.trainers || []).map(t => t.name),
        cycle: c ? { id: c._id, number: c.number } : null,
        classToday: k0 ? { number: k0.number, title: k0.title || '' } : null,
        holidayToday: holOf(b._id, today),
        lastLogDate: lastLog ? lastLog.date : null,
        loggedToday,
        doneTopics: done, totalTopics: due.length, classesInCycle: classes.length,
        planPct: due.length ? Math.round(done / due.length * 100) : 100,
        notLoggedDays,
        nextTopic: !c || !classes.length ? '— no plan —' : next ? (next.title || `Class ${next.number} — topic not typed yet`) : '— cycle plan done —',
        studentCount: countOf.get(String(b._id)) || 0,
      };
    });
    res.json({ semester: { _id: active._id, name: active.name }, today, rows });
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
    // only students of this batch can be marked
    const roster = new Set((await Student.find({ batch }).select('_id').lean()).map(x => String(x._id)));
    for (const a of incoming) if (a && a.student && roster.has(String(a.student))) merged.set(a.student.toString(), !!a.present);

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
