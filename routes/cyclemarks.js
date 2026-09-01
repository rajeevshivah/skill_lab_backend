const express   = require('express');
const CycleMark = require('../models/CycleMark');
const Cycle     = require('../models/Cycle');
const Batch     = require('../models/Batch');
const Student   = require('../models/Student');
const DailyLog  = require('../models/DailyLog');
const { protect, canAccessBatch } = require('../middleware/auth');
const router    = express.Router();

function dayKey(d) { const dt = new Date(d); dt.setHours(0,0,0,0); return dt; }

const countsForAttendance = (log) =>
  log.attendanceTaken || (Array.isArray(log.attendance) && log.attendance.length > 0);

// Per-student attendance % within a cycle's date range.
//
// The denominator is the number of sessions the BATCH held in the window — the
// same rule the roster and Placement Track use. It used to be per-student
// ("sessions where this student was listed"), so the same student showed one
// percentage on the batch page and a different one here.
async function studentAttendance(batchId, start, end) {
  const s = dayKey(start), e = dayKey(end); e.setHours(23,59,59,999);
  const logs = (await DailyLog.find({ batch: batchId, date: { $gte: s, $lte: e } }))
    .filter(countsForAttendance);
  const sessions = logs.length;
  const present = {};
  for (const log of logs) {
    for (const a of log.attendance) {
      const id = a.student.toString();
      present[id] = (present[id] || 0) + (a.present ? 1 : 0);
    }
  }
  return { sessions, pctFor: (id) => sessions ? Math.round(((present[id] || 0) / sessions) * 100) : null };
}

// GET /api/marks/:cycleId  — the marks sheet: every roster student + their mark row
router.get('/:cycleId', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.cycleId).populate('batch', 'name track trainers rosterLocked');
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });

    const students = await Student.find({ batch: cycle.batch._id }).select('name roll').sort('roll name');
    const marks = await CycleMark.find({ cycle: cycle._id });
    const markByStudent = {};
    marks.forEach(m => { markByStudent[m.student.toString()] = m; });

    const attendance = await studentAttendance(cycle.batch._id, cycle.startDate, cycle.endDate);

    const rows = students.map(s => {
      const m = markByStudent[s._id.toString()];
      return {
        student: s._id, name: s.name, roll: s.roll,
        attendancePct: attendance.pctFor(s._id.toString()),
        status: m ? m.status : 'not-evaluated',
        assessment: m ? m.assessment : null,
        project: m ? m.project : null,
        total: m ? m.total : null,
        category: m ? m.category : '',
        categoryOverridden: m ? m.categoryOverridden : false,
        remark: m ? m.remark : '',
      };
    });

    res.json({
      cycle: { _id: cycle._id, number: cycle.number, name: cycle.name, status: cycle.status,
               batch: cycle.batch, startDate: cycle.startDate, endDate: cycle.endDate },
      rosterLocked: !!cycle.batch.rosterLocked,
      sessionsInCycle: attendance.sessions,
      rows,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/marks/:cycleId  — save the whole sheet
// body: { rows: [{student, status, assessment, project, category?, categoryOverridden?, remark}] }
router.put('/:cycleId', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.cycleId);
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    if (!(await canAccessBatch(req.user, cycle.batch)))
      return res.status(403).json({ message: 'Not your batch' });

    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];

    // Validate the WHOLE sheet before writing any of it. This used to be a
    // row-by-row loop, so one out-of-range mark threw halfway through and left
    // the sheet half-saved with a 500 and no indication of where it stopped.
    const errors = [], ops = [];
    const num = (v) => (v == null || v === '' ? 0 : Number(v));

    rows.forEach((r, i) => {
      if (!r.student) return;
      const label = r.name || r.roll || `row ${i + 1}`;
      let assessment = null, project = null, category = '';

      if (r.status === 'evaluated') {
        assessment = num(r.assessment);
        project    = num(r.project);
        if (!Number.isFinite(assessment) || assessment < 0 || assessment > 100)
          errors.push(`${label}: assessment must be a number from 0 to 100`);
        if (!Number.isFinite(project) || project < 0 || project > 100)
          errors.push(`${label}: project must be a number from 0 to 100`);
        category = (r.categoryOverridden && r.category)
          ? r.category
          : CycleMark.categoryFromMarks(assessment, project);
        if (!['excellent', 'moderate', 'basic', 'zero'].includes(category))
          errors.push(`${label}: unknown category "${r.category}"`);
      }

      ops.push({
        updateOne: {
          filter: { cycle: cycle._id, student: r.student },
          update: { $set: {
            cycle: cycle._id, batch: cycle.batch, semester: cycle.semester, student: r.student,
            status: r.status === 'evaluated' ? 'evaluated' : 'not-evaluated',
            assessment, project, category,
            categoryOverridden: !!r.categoryOverridden,
            remark: String(r.remark || '').slice(0, 500),
            updatedBy: req.user._id,
          } },
          upsert: true,
        },
      });
    });

    if (errors.length)
      return res.status(400).json({
        message: `Nothing was saved — ${errors.length} row(s) need fixing.`,
        errors: errors.slice(0, 20),
      });

    if (ops.length) await CycleMark.bulkWrite(ops);
    res.json({ saved: ops.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/marks/:cycleId/top3-suggestion  — top 3 by total marks (evaluated only)
router.get('/:cycleId/top3-suggestion', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.cycleId);
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
    if (!(await canAccessBatch(req.user, cycle.batch)))
      return res.status(403).json({ message: 'Not your batch' });
    const marks = await CycleMark.find({ cycle: cycle._id, status: 'evaluated' })
      .populate('student', 'name roll');
    const ranked = marks
      .map(m => ({ student: m.student?._id, name: m.student?.name, roll: m.student?.roll,
                   total: (m.assessment||0) + (m.project||0) }))
      .filter(x => x.total > 0)
      .sort((a,b) => b.total - a.total)
      .slice(0, 3)
      .map((x, i) => ({ rank: i+1, ...x }));
    res.json({ top3: ranked });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/marks/student/:studentId/history  — category trail across cycles (skips not-evaluated)
router.get('/student/:studentId/history', protect, async (req, res) => {
  try {
    const owner = await Student.findById(req.params.studentId).select('batch');
    if (!owner) return res.status(404).json({ message: 'Student not found' });
    const marks = await CycleMark.find({ student: req.params.studentId, status: 'evaluated' })
      .populate('cycle', 'number name startDate')
      .sort('createdAt');
    const history = marks
      .filter(m => m.cycle)
      .sort((a,b) => new Date(a.cycle.startDate) - new Date(b.cycle.startDate))
      .map(m => ({ cycleNumber: m.cycle.number, cycleName: m.cycle.name,
                   total: (m.assessment||0)+(m.project||0), category: m.category }));
    res.json({ history, baseline: history[0] || null, current: history[history.length-1] || null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
