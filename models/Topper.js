const mongoose = require('mongoose');

const topperSchema = new mongoose.Schema({
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  rank:     { type: Number, required: true, min: 1, max: 3 },
  cycle:    { type: String, required: true },   // "Cycle 1".. kept as label
  project:  { type: String, default: '' },      // project link/description
  addedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// One rank per batch per cycle
topperSchema.index({ batch: 1, cycle: 1, rank: 1 }, { unique: true });

module.exports = mongoose.model('Topper', topperSchema);
