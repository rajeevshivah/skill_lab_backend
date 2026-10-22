const mongoose = require('mongoose');

// The trainer-filled report for a cycle. Numbers are live while the cycle is
// open and frozen (snapshotted) when it is closed.
const reportSchema = new mongoose.Schema({
  submitted:   { type: Boolean, default: false },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  submittedAt: { type: Date, default: null },

  // ---- Auto-filled from app data (editable by trainer). Snapshotted on close. ----
  avgAttendance:   { type: Number, default: null }, // %
  sessionsHeld:    { type: Number, default: null },
  topicsPlanned:   { type: Number, default: null },
  topicsCompleted: { type: Number, default: null },
  // top3 captured as text so the report stays stable even if toppers change later
  top3: [{
    rank:   Number,
    student:{ type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    name:   String,
    roll:   String,
    github: { type: String, default: '' },
    photo:  { data: { type: String, default: null }, contentType: { type: String, default: null } },
  }],

  // ---- Trainer structured (trackable across cycles) ----
  syllabusCoverage: { type: String, enum: ['on-track', 'behind', 'ahead', ''], default: '' },
  coverageNote:     { type: String, default: '' },
  submittedCount:   { type: Number, default: null }, // projects submitted
  totalStudents:    { type: Number, default: null },
  performanceRating:{ type: Number, default: null, min: 0, max: 5 }, // overall batch, 1-5
  trainerConfidence:{ type: Number, default: null, min: 0, max: 5 }, // trainer self, 1-5

  // ---- Trainer free text (the "why") ----
  problemsFaced:      { type: String, default: '' },
  improvementNeeded:  { type: String, default: '' },
  standoutStudents:   { type: String, default: '' },
  strugglingStudents: { type: String, default: '' },
  topicsNotCovered:   { type: String, default: '' },
  reflection:         { type: String, default: '' },
  projectTitle:       { type: String, default: '' },
  projectNote:        { type: String, default: '' },
}, { _id: false });

// Who first completed a piece of cycle work, and when. admin=true means it was
// done by someone who is not a trainer of the batch (e.g. the superadmin).
const stampSchema = new mongoose.Schema({
  at:    { type: Date, default: null },
  by:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  admin: { type: Boolean, default: false },
}, { _id: false });

// Trainer accountability (see services/performance.js)
const trackSchema = new mongoose.Schema({
  tracked:     { type: Boolean, default: false },   // only tracked cycles are scored
  projectDate: { type: Date, default: null },       // default: cycle end date
  deadline:    { type: Date, default: null },       // default: Saturday after project day, 7 PM IST
  excusedNote: { type: String, default: '' },       // admin: lateness not penalised
  report: { type: stampSchema, default: null },
  marks:  { type: stampSchema, default: null },
  top3:   { type: stampSchema, default: null },
  plan:   { type: stampSchema, default: null },
  // Who is responsible (batches with several trainers) — see services/performance.js
  lead:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  owners: {
    report: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    marks:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    top3:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    plan:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  // "Waiting on another trainer" — counts only once the admin approves it
  waits: [{
    item:      { type: String, enum: ['report', 'marks', 'top3'] },
    owner:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    waitingOn: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note:      { type: String, default: '' },
    raisedAt:  Date,
    status:    { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedAt: Date,
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  }],
  lateEdits: [{
    _id: false, item: String, at: Date,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, admin: Boolean,
  }],
}, { _id: false });

const cycleSchema = new mongoose.Schema({
  batch:     { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  semester:  { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  number:    { type: Number, required: true },       // per-batch cycle number (auto-suggested, overridable)
  name:      { type: String, default: '' },          // optional label
  startDate: { type: Date, required: true },
  endDate:   { type: Date, required: true },
  // active = teaching; report-open = trainers can fill; closed = frozen
  status:    { type: String, enum: ['active', 'report-open', 'closed'], default: 'active' },
  // The MCQ assessment is optional. When false, a student's cycle score is the
  // project mark out of 100 and the category comes from the project % alone.
  assessmentHeld: { type: Boolean, default: true },
  report:    { type: reportSchema, default: () => ({}) },
  track:     { type: trackSchema, default: () => ({}) },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  closedAt:  { type: Date, default: null },
}, { timestamps: true });

cycleSchema.index({ batch: 1, number: 1 }, { unique: true });
cycleSchema.index({ semester: 1 });

module.exports = mongoose.model('Cycle', cycleSchema);
