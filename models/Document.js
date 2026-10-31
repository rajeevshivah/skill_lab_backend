const mongoose = require('mongoose');

// A file a student (or staff) uploaded: resume, marksheet, a JD PDF …
// Stored in file storage (key) when it is set up, else inside this record
// (data, never sent in lists). services/documents.js reads and checks them.
const KINDS = ['resume', 'marksheet', 'jd', 'other'];

const documentSchema = new mongoose.Schema({
  owner:       { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },   // the student it belongs to (null = staff file, e.g. a JD)
  kind:        { type: String, enum: KINDS, default: 'other' },
  name:        { type: String, default: 'file', trim: true, maxlength: 120 },
  contentType: { type: String, required: true },
  size:        { type: Number, default: 0 },
  data:        { type: String, default: null, select: false },
  key:         { type: String, default: null },
  uploadedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

documentSchema.plugin(require('../services/tenant').plugin);   // college wall
documentSchema.index({ org: 1, owner: 1, kind: 1 });
documentSchema.statics.KINDS = KINDS;

module.exports = mongoose.model('Document', documentSchema);
