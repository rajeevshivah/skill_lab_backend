// ─────────────────────────────────────────────────────────────────────
//  Top 3 of a cycle — straight from the marks, so the Hall of Fame updates
//  itself. Flow: trainer saves marks → once EVERY student of the batch has a
//  mark (evaluated or not evaluated) the Top 3 is published on the cycle and
//  the Hall of Fame shows that cycle for the batch. Until then the board keeps
//  showing the batch's previous cycle.
//
//  Ranking: total marks (high → low); ties go to the higher project mark, then
//  the higher assessment, then roll number. Students with 0 total never rank.
//  Each topper gets their submitted project link (else their GitHub profile)
//  and keeps any photo / link a trainer already added.
//
//  A trainer may still change the Top 3 by hand on the cycle report
//  (report.top3Manual) — then new marks don't overwrite it, until the trainer
//  presses "Back to automatic".
// ─────────────────────────────────────────────────────────────────────
const CycleMark = require('../models/CycleMark');
const Student   = require('../models/Student');
const ProjectSubmission = require('../models/ProjectSubmission');
const perf = require('./performance');
const stats = require('./studentStats');

const sid = (x) => x == null ? '' : String(x._id || x);

// [{ rank, student, name, roll, total, project, assessment }] — best first
async function rank(cycle) {
  const held = cycle.assessmentHeld !== false;
  const marks = await CycleMark.find({ cycle: cycle._id, status: 'evaluated' }).populate('student', 'name roll').lean();
  return marks
    .filter(m => m.student)
    .map(m => ({ student: m.student._id, name: m.student.name, roll: m.student.roll || '',
      total: CycleMark.scoreOf(m.assessment, m.project, held).total, project: m.project || 0, assessment: m.assessment || 0 }))
    .filter(x => x.total > 0)
    .sort((a, b) => b.total - a.total || b.project - a.project || b.assessment - a.assessment || String(a.roll).localeCompare(String(b.roll)))
    .slice(0, 3)
    .map((x, i) => ({ rank: i + 1, ...x }));
}

// Recompute and store the Top 3 if marks are complete. Returns true if it changed.
// The caller saves the cycle.
async function publish(cycle, user) {
  if (cycle.status === 'closed' || cycle.report?.top3Manual) return false;
  if (!(await perf.marksComplete(cycle))) return false;
  const ranked = await rank(cycle);
  const before = (cycle.report.top3 || []).map(t => sid(t.student)).join(',');
  const ids = ranked.map(r => r.student);
  const [subs, students] = await Promise.all([
    ProjectSubmission.find({ cycle: cycle._id, student: { $in: ids } }).select('student githubUrl').lean(),
    Student.find({ _id: { $in: ids } }).select('github photo').lean(),
  ]);
  const prev = new Map((cycle.report.top3 || []).map(t => [sid(t.student), t]));
  cycle.report.top3 = ranked.map(r => {
    const old = prev.get(sid(r.student));
    const st = students.find(x => sid(x._id) === sid(r.student));
    const sub = subs.find(x => sid(x.student) === sid(r.student));
    return {
      rank: r.rank, student: r.student, name: r.name, roll: r.roll,
      github: old?.github || sub?.githubUrl || st?.github || '',
      // the student's own profile photo first (services/studentPhoto.js), else one a trainer added here
      photo: st?.photo?.data ? { data: st.photo.data, contentType: st.photo.contentType } : (old?.photo?.data ? old.photo : { data: null, contentType: null }),
    };
  });
  cycle.markModified('report');
  if (ranked.length) await perf.stamp(cycle, 'top3', user);
  const after = ids.map(String).join(',');
  if (before !== after) await stats.recompute([...before.split(','), ...after.split(',')].filter(Boolean));
  return before !== after;
}

module.exports = { rank, publish };
