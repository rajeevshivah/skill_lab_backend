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
  top3: [{ rank: Number, name: String, roll: String }],

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

const cycleSchema = new mongoose.Schema({
  batch:     { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  semester:  { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  number:    { type: Number, required: true },       // per-batch cycle number (auto-suggested, overridable)
  name:      { type: String, default: '' },          // optional label
  startDate: { type: Date, required: true },
  endDate:   { type: Date, required: true },
  // active = teaching; report-open = trainers can fill; closed = frozen
  status:    { type: String, enum: ['active', 'report-open', 'closed'], default: 'active' },
  report:    { type: reportSchema, default: () => ({}) },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  closedAt:  { type: Date, default: null },
}, { timestamps: true });

cycleSchema.index({ batch: 1, number: 1 }, { unique: true });
cycleSchema.index({ semester: 1 });

module.exports = mongoose.model('Cycle', cycleSchema);
