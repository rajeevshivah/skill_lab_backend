// ─────────────────────────────────────────────────────────────────────
//  Merge two records of the SAME student in one batch (a double import, a
//  typo in the name): everything the duplicate carries moves to the record
//  you keep — marks, attendance, class check-ins, project submissions,
//  feedback votes, Top-3 places, sign-in and photo — then the duplicate is
//  removed. Where both have something for the same thing, the more complete
//  one wins (an evaluated mark over a not-evaluated one; "present" over
//  "absent"; the later project submission).
// ─────────────────────────────────────────────────────────────────────
const Student = require('../models/Student');
const CycleMark = require('../models/CycleMark');
const DailyLog = require('../models/DailyLog');
const ClassPulse = require('../models/ClassPulse');
const ProjectSubmission = require('../models/ProjectSubmission');
const Topper = require('../models/Topper');
const Cycle = require('../models/Cycle');
const { Feedback } = require('../models/Feedback');
const { recomputeBatchStats } = require('./attendanceStats');
const studentStats = require('./studentStats');

class MergeError extends Error {}
const sid = (x) => String(x?._id || x);

// What would move (for the preview) — counts only, nothing is changed.
async function preview(keepId, dropId) {
  const [keep, drop] = await load(keepId, dropId);
  const [marks, logs, pulses, subs, votes, tops] = await Promise.all([
    CycleMark.countDocuments({ student: drop._id }),
    DailyLog.countDocuments({ 'attendance.student': drop._id }),
    ClassPulse.countDocuments({ student: drop._id }),
    ProjectSubmission.countDocuments({ student: drop._id }),
    Feedback.countDocuments({ student: drop._id }),
    Cycle.countDocuments({ 'report.top3.student': drop._id }),
  ]);
  return { keep: brief(keep), drop: brief(drop), moves: { marks, attendanceDays: logs, checkIns: pulses, projectSubmissions: subs, feedbackVotes: votes, top3: tops } };
}
const brief = (s) => ({ id: s._id, name: s.name, roll: s.roll, course: s.course, sem: s.sem, section: s.section,
  signedUp: !!s.login?.activatedAt, hasPhoto: !!s.photo?.contentType });

async function load(keepId, dropId) {
  if (sid(keepId) === sid(dropId)) throw new MergeError('Pick two different records.');
  const [keep, drop] = await Promise.all([
    Student.findById(keepId).select('+login.passwordHash').setOptions({ withDemo: true }),
    Student.findById(dropId).select('+login.passwordHash').setOptions({ withDemo: true }),
  ]);
  if (!keep || !drop) throw new MergeError('Student not found.');
  if (sid(keep.batch) !== sid(drop.batch)) throw new MergeError('Both records must be in the same batch. For the same student in two batches, keep one batch on the Duplicates page.');
  return [keep, drop];
}

// Move rows with a unique (…, student) key: re-point, or drop the duplicate's
// row when the kept student already has one (unless `better` says the
// duplicate's row is the better one — then it replaces the kept one).
async function moveUnique(Model, keyFields, keep, drop, better = () => false) {
  const rows = await Model.find({ student: drop._id }).lean();
  let moved = 0;
  for (const r of rows) {
    const key = Object.fromEntries(keyFields.map(f => [f, r[f]]));
    const mine = await Model.findOne({ ...key, student: keep._id }).lean();
    if (mine && !better(r, mine)) { await Model.deleteOne({ _id: r._id }); continue; }
    if (mine) await Model.deleteOne({ _id: mine._id });
    await Model.updateOne({ _id: r._id }, { $set: { student: keep._id } });
    moved++;
  }
  return moved;
}

async function merge(keepId, dropId, by) {
  const [keep, drop] = await load(keepId, dropId);
  const out = {};

  out.marks = await moveUnique(CycleMark, ['cycle'], keep, drop, (d, k) => d.status === 'evaluated' && k.status !== 'evaluated');
  out.checkIns = await moveUnique(ClassPulse, ['batch', 'date'], keep, drop);
  out.projectSubmissions = await moveUnique(ProjectSubmission, ['cycle'], keep, drop, (d, k) => new Date(d.submittedAt || 0) > new Date(k.submittedAt || 0));
  out.feedbackVotes = await moveUnique(Feedback, ['window', 'trainer'], keep, drop);
  out.oldToppers = await moveUnique(Topper, ['batch', 'cycle', 'rank'], keep, drop);

  // attendance: one entry per student per day; present wins
  const logs = await DailyLog.find({ 'attendance.student': drop._id });
  for (const log of logs) {
    const d = log.attendance.find(a => sid(a.student) === sid(drop._id));
    const k = log.attendance.find(a => sid(a.student) === sid(keep._id));
    if (k) { k.present = k.present || d.present; log.attendance = log.attendance.filter(a => a !== d); }
    else d.student = keep._id;
    log.markModified('attendance');
    await log.save();
  }
  out.attendanceDays = logs.length;

  // Top 3 on cycle reports (Hall of Fame)
  const cycles = await Cycle.find({ 'report.top3.student': drop._id });
  for (const c of cycles) {
    for (const t of c.report.top3) if (sid(t.student) === sid(drop._id)) { t.student = keep._id; if (t.name === drop.name) t.name = keep.name; }
    c.markModified('report.top3');
    await c.save();
  }
  out.top3 = cycles.length;

  // the kept record takes what it lacks from the duplicate
  for (const f of ['roll', 'course', 'sem', 'section', 'year', 'github']) if (!keep[f] && drop[f]) keep[f] = drop[f];
  if (!keep.photo?.contentType && drop.photo?.contentType) keep.photo = drop.photo;
  if (!keep.login?.passwordHash && drop.login?.passwordHash) keep.login = drop.login;
  keep.flagged = keep.flagged || drop.flagged;
  if (by) keep.updatedBy = by;
  await keep.save();
  await Student.deleteOne({ _id: drop._id });

  await recomputeBatchStats(keep.batch);
  await studentStats.recompute([keep._id]);
  return { kept: brief(keep), removed: { id: drop._id, name: drop.name, roll: drop.roll }, moved: out };
}

module.exports = { merge, preview, MergeError };
