const mongoose = require('mongoose');

// One planned class within a cycle.
const classEntrySchema = new mongoose.Schema({
  number: { type: Number, required: true },        // Class 1, 2, 3… (order)
  title:  { type: String, default: '' },
  notes:  { type: String, default: '' },
  trainer:{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  date:   { type: String, default: '' },           // 'YYYY-MM-DD' (kept as string; simple + tz-safe)
  time:   { type: String, default: '' },           // 'HH:MM' free text
  updatedAt: { type: Date, default: null },        // last change to THIS row (conflict check for one-row edits)
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { _id: true });

// One plan per cycle (a cycle belongs to one batch, so this is per-batch-per-cycle).
const cyclePlanSchema = new mongoose.Schema({
  cycle:    { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle',   required: true, unique: true },
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch',   required: true },
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  classes:  { type: [classEntrySchema], default: [] },
  updatedBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // What changed, by whom, when (newest last; last 60 kept)
  changes:  [{
    _id: false, at: Date,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: String,
  }],
}, { timestamps: true, optimisticConcurrency: true });   // two saves at once → the second gets a VersionError (→ 409), never a silent overwrite

cyclePlanSchema.index({ batch: 1 });

module.exports = mongoose.model('CyclePlan', cyclePlanSchema);
