const mongoose = require('mongoose');

// A student's project submission for one cycle (replaces the Google Form).
const projectSubmissionSchema = new mongoose.Schema({
  cycle:    { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle', required: true },
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  githubUrl:{ type: String, default: '' },
  liveUrl:  { type: String, default: '' },
  note:     { type: String, default: '' },
  screenshot: {
    data:        { type: String, default: null, select: false },   // base64
    contentType: { type: String, default: null },
  },
  submittedAt: { type: Date, default: Date.now },   // last time it was (re)submitted
  late:        { type: Boolean, default: false },   // submitted after the window closed
}, { timestamps: true });

projectSubmissionSchema.index({ cycle: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('ProjectSubmission', projectSubmissionSchema);
