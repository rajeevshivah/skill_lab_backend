const mongoose = require('mongoose');

// A student's project submission for one cycle (replaces the Google Form).
const projectSubmissionSchema = new mongoose.Schema({
  cycle:    { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle', required: true },
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  githubUrl:{ type: String, default: '' },
  liveUrl:  { type: String, default: '' },
  note:     { type: String, default: '' },
  // Code pasted by the student (when they could not push to GitHub, or as well
  // as a link): one entry per file. Lists leave `code` out; it loads on demand.
  files: [{ _id: false,
    name:     { type: String, default: '' },        // "App.jsx"
    language: { type: String, default: 'text' },    // services/projectCode.js LANGUAGES
    code:     { type: String, default: '' },
  }],
  screenshot: {
    data:        { type: String, default: null, select: false },   // base64
    contentType: { type: String, default: null },
  },
  submittedAt: { type: Date, default: Date.now },   // last time it was (re)submitted
  late:        { type: Boolean, default: false },   // submitted after the window closed
}, { timestamps: true });

projectSubmissionSchema.index({ cycle: 1, student: 1 }, { unique: true });

projectSubmissionSchema.plugin(require('../services/tenant').plugin);   // college wall: every record + query belongs to one college
module.exports = mongoose.model('ProjectSubmission', projectSubmissionSchema);
