const mongoose = require('mongoose');

// The admin opens a feedback window for some batches; students rate each of
// their trainers once per window. Trainers only ever see averages (5+ answers).
const feedbackWindowSchema = new mongoose.Schema({
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  title:    { type: String, default: 'Trainer feedback' },
  batches:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Batch' }],
  openFrom: { type: Date, required: true },
  openUntil:{ type: Date, required: true },
  createdBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const feedbackSchema = new mongoose.Schema({
  window:  { type: mongoose.Schema.Types.ObjectId, ref: 'FeedbackWindow', required: true },
  batch:   { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  trainer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true, select: false }, // only to stop double voting
  ratings: {
    clarity:     { type: Number, min: 1, max: 5, required: true },
    punctuality: { type: Number, min: 1, max: 5, required: true },
    help:        { type: Number, min: 1, max: 5, required: true },
    practical:   { type: Number, min: 1, max: 5, required: true },
    overall:     { type: Number, min: 1, max: 5, required: true },
  },
  comment: { type: String, default: '', maxlength: 1000 },
}, { timestamps: true });

feedbackSchema.index({ window: 1, trainer: 1, student: 1 }, { unique: true });

const QUESTIONS = [
  ['clarity', 'Explains concepts clearly'],
  ['punctuality', 'Starts on time and uses the full class'],
  ['help', 'Helps when I am stuck'],
  ['practical', 'Classes are hands-on and practical'],
  ['overall', 'Overall, I am happy with this trainer'],
];

module.exports = {
  FeedbackWindow: mongoose.model('FeedbackWindow', feedbackWindowSchema),
  Feedback: mongoose.model('Feedback', feedbackSchema),
  QUESTIONS,
};
