const mongoose = require('mongoose');

// One planned class within a cycle.
const classEntrySchema = new mongoose.Schema({
  number: { type: Number, required: true },        // Class 1, 2, 3… (order)
  title:  { type: String, default: '' },
  notes:  { type: String, default: '' },
  trainer:{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  date:   { type: String, default: '' },           // 'YYYY-MM-DD' (kept as string; simple + tz-safe)
  time:   { type: String, default: '' },           // 'HH:MM' free text
}, { _id: true });

// One plan per cycle (a cycle belongs to one batch, so this is per-batch-per-cycle).
const cyclePlanSchema = new mongoose.Schema({
  cycle:    { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle',   required: true, unique: true },
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch',   required: true },
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  classes:  { type: [classEntrySchema], default: [] },
  updatedBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

cyclePlanSchema.index({ batch: 1 });

module.exports = mongoose.model('CyclePlan', cyclePlanSchema);
