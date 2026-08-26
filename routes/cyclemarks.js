const express   = require('express');
const CycleMark = require('../models/CycleMark');
const Cycle     = require('../models/Cycle');
const Batch     = require('../models/Batch');
const Student   = require('../models/Student');
const DailyLog  = require('../models/DailyLog');
const { protect, canAccessBatch } = require('../middleware/auth');
const router    = express.Router();

function dayKey(d) { const dt = new Date(d); dt.setHours(0,0,0,0); return dt; }

// Per-student attendance % within a cycle's date range (safe even if roster unfinalised).
async function studentAttendance(batchId, start, end) {
  const s = dayKey(start), e = dayKey(end); e.setHours(23,59,59,999);
  const logs = await DailyLog.find({ batch: batchId, date: { $gte: s, $lte: e } });
  const present = {}, seen = {};
  for (const log of logs) {
    for (const a of log.attendance) {
      const id = a.student.toString();
      seen[id] = (seen[id] || 0) + 1;
      present[id] = (present[id] || 0) + (a.present ? 1 : 0);
    }
  }
  const pct = {};
  for (const id of Object.keys(seen)) pct[id] = seen[id] ? Math.round((present[id] / seen[id]) * 100) : 0;
  return pct;
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
        attendancePct: attendance[s._id.toString()] ?? null,
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
    for (const r of rows) {
      if (!r.student) continue;
      let category = '';
      let assessment = null, project = null;
      if (r.status === 'evaluated') {
        assessment = r.assessment == null || r.assessment === '' ? 0 : Number(r.assessment);
        project    = r.project == null || r.project === '' ? 0 : Number(r.project);
        category = (r.categoryOverridden && r.category)
          ? r.category
          : CycleMark.categoryFromMarks(assessment, project);
      }
      await CycleMark.findOneAndUpdate(
        { cycle: cycle._id, student: r.student },
        {
          cycle: cycle._id, batch: cycle.batch, semester: cycle.semester, student: r.student,
          status: r.status === 'evaluated' ? 'evaluated' : 'not-evaluated',
          assessment, project, category,
          categoryOverridden: !!r.categoryOverridden,
          remark: r.remark || '', updatedBy: req.user._id,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
    res.json({ saved: rows.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/marks/:cycleId/top3-suggestion  — top 3 by total marks (evaluated only)
router.get('/:cycleId/top3-suggestion', protect, async (req, res) => {
  try {
    const cycle = await Cycle.findById(req.params.cycleId);
    if (!cycle) return res.status(404).json({ message: 'Cycle not found' });
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
