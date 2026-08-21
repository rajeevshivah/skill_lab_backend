const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  roll:    { type: String, default: '', trim: true },
  // Academic identity
  course:  { type: String, default: '' },  // B.Tech / BCA
  sem:     { type: String, default: '' },  // "3rd Sem"
  section: { type: String, default: '' },  // "Sec A" (their real academic section)
  year:    { type: String, default: '' },
  // Which batch they train in THIS semester
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  // Cumulative performance signals (auto-updated) — powers the Placement Track
  stats: {
    topperCount:   { type: Number, default: 0 },  // times finished top-3
    projectCount:  { type: Number, default: 0 },  // projects pushed
    presentCount:  { type: Number, default: 0 },  // sessions present
    totalSessions: { type: Number, default: 0 },  // sessions held for their batch
  },
  // Manual flag from a trainer — "watch this one"
  flagged:  { type: Boolean, default: false },
  photo: {
    data:        { type: String, default: null },
    contentType: { type: String, default: null },
  },
  addedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

studentSchema.index({ batch: 1, roll: 1 });
studentSchema.index({ semester: 1 });

studentSchema.virtual('attendancePct').get(function () {
  if (!this.stats.totalSessions) return 0;
  return Math.round((this.stats.presentCount / this.stats.totalSessions) * 100);
});

studentSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Student', studentSchema);
