const mongoose = require('mongoose');

// A student's quick answer after a class: was today's planned topic covered,
// and how well did they understand it. Shown to staff only as batch totals.
const classPulseSchema = new mongoose.Schema({
  batch:   { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  date:    { type: String, required: true },                  // 'YYYY-MM-DD' (India date)
  planClass: { type: Number, default: null },
  covered: { type: String, enum: ['yes', 'partly', 'no'], required: true },
  understanding: { type: Number, min: 1, max: 5, required: true },
}, { timestamps: true });

classPulseSchema.index({ batch: 1, student: 1, date: 1 }, { unique: true });
classPulseSchema.index({ batch: 1, date: 1 });

module.exports = mongoose.model('ClassPulse', classPulseSchema);
