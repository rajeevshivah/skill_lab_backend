// Per-student counters used by the Placement ranking, worked out from the real
// records (not typed in by hand):
//   topperCount  — cycles where the student is in the Top 3 (cycle reports)
//   projectCount — projects the student submitted (project submissions)
const Student = require('../models/Student');
const Cycle = require('../models/Cycle');
const ProjectSubmission = require('../models/ProjectSubmission');

async function recompute(studentIds) {
  const ids = [...new Set((studentIds || []).map(String).filter(Boolean))];
  if (!ids.length) return;
  const [tops, subs] = await Promise.all([
    Cycle.find({ 'report.top3.student': { $in: ids } }).select('report.top3.student').lean(),
    ProjectSubmission.find({ student: { $in: ids } }).select('student').lean(),
  ]);
  const ops = ids.map(id => ({
    updateOne: { filter: { _id: id }, update: { $set: {
      'stats.topperCount': tops.filter(c => c.report.top3.some(t => String(t.student) === id)).length,
      'stats.projectCount': subs.filter(s => String(s.student) === id).length,
    } } },
  }));
  await Student.bulkWrite(ops);
}

module.exports = { recompute };
