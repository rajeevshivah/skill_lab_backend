// Per-student attendance counters (stats.presentCount / stats.totalSessions)
// for one batch, recomputed from its daily logs. Called whenever logs change
// (routes/logs.js) or students are merged (services/studentMerge.js).
const DailyLog = require('../models/DailyLog');
const Student = require('../models/Student');

// Sessions that count towards attendance: logs where the roll call was actually
// taken. Logs written before this field existed are treated as counted when
// they carry attendance entries, so historical numbers don't move.
const countsForAttendance = (log) =>
  log.attendanceTaken || (Array.isArray(log.attendance) && log.attendance.length > 0);

// One bulkWrite instead of one save() per student.
async function recomputeBatchStats(batchId) {
  const logs = (await DailyLog.find({ batch: batchId }).select('attendance attendanceTaken').lean()).filter(countsForAttendance);
  const totalSessions = logs.length;
  const presentMap = {};
  for (const log of logs) for (const a of log.attendance || []) {
    const id = String(a.student);
    presentMap[id] = (presentMap[id] || 0) + (a.present ? 1 : 0);
  }
  const students = await Student.find({ batch: batchId }).select('_id').lean();
  if (!students.length) return;
  await Student.bulkWrite(students.map(s => ({
    updateOne: { filter: { _id: s._id }, update: { $set: {
      'stats.totalSessions': totalSessions, 'stats.presentCount': presentMap[String(s._id)] || 0,
    } } },
  })));
}

module.exports = { recomputeBatchStats, countsForAttendance };
