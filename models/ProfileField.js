const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
//  An extra field a college adds to its student profiles (no code change):
//  "10th %", "Passport ready", "Preferred city" … Values live in
//  Person.custom[key]. Modules (placement criteria, notices) read them the
//  same way as built-in fields.
//    editableBy        — who may fill it: staff only, or the student too
//    needsVerification — a student-filled value counts only once staff check it
// ─────────────────────────────────────────────────────────────────────
const TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'boolean', 'url', 'file'];   // file: a Document id (marksheet …)

const profileFieldSchema = new mongoose.Schema({
  key:      { type: String, required: true, trim: true, lowercase: true, match: /^[a-z][a-z0-9_]{1,39}$/ },
  label:    { type: String, required: true, trim: true, maxlength: 80 },
  type:     { type: String, enum: TYPES, default: 'text' },
  options:  { type: [String], default: [] },                       // select / multiselect choices
  group:    { type: String, default: 'Other', trim: true, maxlength: 40 },   // section of the profile page
  help:     { type: String, default: '', trim: true, maxlength: 200 },
  required: { type: Boolean, default: false },
  min:      { type: Number, default: null },                       // number limits
  max:      { type: Number, default: null },
  editableBy:        { type: String, enum: ['staff', 'student'], default: 'staff' },
  needsVerification: { type: Boolean, default: false },
  order:    { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

profileFieldSchema.plugin(require('../services/tenant').plugin);   // college wall
profileFieldSchema.index({ org: 1, key: 1 }, { unique: true });
profileFieldSchema.statics.TYPES = TYPES;

module.exports = mongoose.model('ProfileField', profileFieldSchema);
