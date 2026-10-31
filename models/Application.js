const mongoose = require('mongoose');

// A student's application to a drive. `snapshot` keeps exactly what the student
// had in their profile when they applied (name, programme, marks …) so later
// edits never change what was sent to the company. `unverified` lists the
// values the college had not checked yet at that moment.
const applicationSchema = new mongoose.Schema({
  drive:      { type: mongoose.Schema.Types.ObjectId, ref: 'Drive', required: true },
  person:     { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true },
  status:     { type: String, enum: ['applied', 'withdrawn'], default: 'applied' },
  answers:    { type: mongoose.Schema.Types.Mixed, default: {} },
  resume:     { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  snapshot:   { type: mongoose.Schema.Types.Mixed, default: {} },
  unverified: { type: [String], default: [] },
  declaredAt: { type: Date, default: null },     // "I confirm my details are correct"
  appliedAt:  { type: Date, default: Date.now },
  withdrawnAt:{ type: Date, default: null },
}, { timestamps: true, minimize: false });

applicationSchema.plugin(require('../services/tenant').plugin);   // college wall
applicationSchema.index({ org: 1, drive: 1, person: 1 }, { unique: true });
applicationSchema.index({ org: 1, person: 1 });

module.exports = mongoose.model('Application', applicationSchema);
