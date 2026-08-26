const mongoose = require('mongoose');

// One record per student per cycle.
const cycleMarkSchema = new mongoose.Schema({
  cycle:    { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle',   required: true },
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch',   required: true },
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },

  // 'evaluated' = has marks; 'not-evaluated' = absent on eval day / joined late (no data point)
  status: { type: String, enum: ['evaluated', 'not-evaluated'], default: 'not-evaluated' },

  assessment: { type: Number, default: null, min: 0, max: 100 },
  project:    { type: Number, default: null, min: 0, max: 100 },
  // category: computed from total% when evaluated, but trainer can override
  category:   { type: String, enum: ['excellent', 'moderate', 'basic', 'zero', ''], default: '' },
  categoryOverridden: { type: Boolean, default: false },
  remark:     { type: String, default: '' },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

cycleMarkSchema.index({ cycle: 1, student: 1 }, { unique: true });
cycleMarkSchema.index({ batch: 1 });
cycleMarkSchema.index({ student: 1 });

// total out of 200 (null if not fully evaluated)
cycleMarkSchema.virtual('total').get(function () {
  if (this.status !== 'evaluated') return null;
  const a = this.assessment || 0, p = this.project || 0;
  return a + p;
});

cycleMarkSchema.set('toJSON', { virtuals: true });

// Category from total percentage: Excellent >=75, Moderate 50-74, Basic 1-49, Zero = 0
cycleMarkSchema.statics.categoryFromMarks = function (assessment, project) {
  const total = (assessment || 0) + (project || 0);
  const pct = (total / 200) * 100;
  if (pct === 0) return 'zero';
  if (pct >= 75) return 'excellent';
  if (pct >= 50) return 'moderate';
  return 'basic';
};

module.exports = mongoose.model('CycleMark', cycleMarkSchema);
