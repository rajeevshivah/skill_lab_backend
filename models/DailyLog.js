const mongoose = require('mongoose');

const attendanceEntrySchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  present: { type: Boolean, default: true },
}, { _id: false });

const dailyLogSchema = new mongoose.Schema({
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  date:     { type: Date, required: true },
  loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Topics touched today (references into the Plan's topics) + how it went
  topicsCovered: [{ type: mongoose.Schema.Types.ObjectId }], // topic _ids within the Plan
  status:   { type: String, enum: ['done', 'partial', 'not-covered'], default: 'done' },
  // What was actually taught, in words
  notes:    { type: String, default: '' },
  // Trainer prep evidence
  prepLink: { type: String, default: '' },
  // Roll-wise attendance
  attendance: [attendanceEntrySchema],
}, { timestamps: true });

// One log per batch per day
dailyLogSchema.index({ batch: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyLog', dailyLogSchema);
