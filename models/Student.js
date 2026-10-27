const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  roll:    { type: String, default: '', trim: true },
  // A temporary ID made by the platform (TMP-XXXXX) for a student who has no
  // roll number yet (lateral entry, late admission). They sign in with it; when
  // the real roll is entered it replaces it and the sign-in keeps working.
  rollTemporary: { type: Boolean, default: false },
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
  // Demo / review account (e.g. for the MD to try the student side). Left out of
  // every roster, count, marks sheet, attendance and Top 3 — see the hook below —
  // and nothing a demo student answers is saved.
  demo:     { type: Boolean, default: false },
  // Manual flag from a trainer — "watch this one"
  flagged:  { type: Boolean, default: false },
  photo: {
    data:        { type: String, default: null },
    contentType: { type: String, default: null },
  },
  // Student's own GitHub profile (they can edit it after signing in)
  github:   { type: String, default: '', trim: true },
  // Student sign-in (roll number + password). The hash is never sent to anyone.
  login: {
    passwordHash: { type: String, default: null, select: false },
    activatedAt:  { type: Date, default: null },
    lastLoginAt:  { type: Date, default: null },
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

// Demo students are invisible to lists and counts unless a query asks for them
// with .setOptions({ withDemo: true }) (student sign-in, the Student login tab).
// findById/findOne are not filtered, so a demo student can still open their page.
function hideDemo() {
  if (this.getOptions().withDemo) return;
  const q = this.getQuery();
  if (!('demo' in q)) this.where({ demo: { $ne: true } });
}
studentSchema.pre('find', hideDemo);
studentSchema.pre('countDocuments', hideDemo);
studentSchema.pre('aggregate', function () {
  if (this.options?.withDemo) return;
  this.pipeline().unshift({ $match: { demo: { $ne: true } } });
});

studentSchema.plugin(require('../services/tenant').plugin);   // college wall: every record + query belongs to one college
module.exports = mongoose.model('Student', studentSchema);
