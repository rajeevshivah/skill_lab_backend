const mongoose = require('mongoose');

const attendanceEntrySchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  present: { type: Boolean, default: true },
}, { _id: false });

const dailyLogSchema = new mongoose.Schema({
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  date:     { type: Date, required: true },
  loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },   // last person who saved
  firstLoggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // who created it (never changes)
  // Topics touched today (references into the Plan's topics) + how it went
  topicsCovered: [{ type: mongoose.Schema.Types.ObjectId }], // topic _ids within the Plan
  // done = as planned · partial = partly · not-covered = planned class not done
  // no-class = no class that day (holiday, exam, cancelled) — admin only; the day is not scored
  status:   { type: String, enum: ['done', 'partial', 'not-covered', 'no-class'], default: 'done' },
  // Logging rule (from 26 Oct 2026): which planned class this was (cycle plan class number)
  planClass: { type: Number, default: null },
  // Did students push today's code to GitHub?  all / most / few / none / na (not needed today)
  github:   { type: String, enum: ['', 'all', 'most', 'few', 'none', 'na'], default: '' },
  // First time the log met the rule (plan class + status + GitHub answer [+ note if not done])
  completeAt: { type: Date, default: null },
  // What was actually taught, in words
  notes:    { type: String, default: '' },
  // Trainer prep evidence
  prepLink: { type: String, default: '' },
  // Roll-wise attendance
  attendance: [attendanceEntrySchema],
  // Was attendance actually taken for this session? A log saved without it must
  // NOT count towards anyone's attendance denominator — otherwise a trainer who
  // forgets the roll call silently drops every student's percentage.
  attendanceTaken: { type: Boolean, default: false },
  // Every trainer who has contributed to this day's log (two trainers can share
  // a batch and must not silently overwrite one another).
  contributors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

// One log per batch per day
dailyLogSchema.index({ batch: 1, date: 1 }, { unique: true });

dailyLogSchema.plugin(require('../services/tenant').plugin);   // college wall: every record + query belongs to one college
module.exports = mongoose.model('DailyLog', dailyLogSchema);
