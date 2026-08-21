const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true }, // "BTech 3rd Sem Combined", "MERN Track"
  semester:    { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  // Free-text description of who is in it, for reference
  composition: { type: String, default: '' }, // "BTech 3rd Sem Sec A + Sec B"
  // Track/stream label (optional) — e.g. MERN, Spring Boot, Data Analysis, C++
  track:       { type: String, default: '' },
  // One or more trainers assigned to this batch
  trainers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isActive:    { type: Boolean, default: true },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

batchSchema.index({ semester: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Batch', batchSchema);
