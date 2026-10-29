const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
//  A cohort: everyone admitted to one programme (+ branch) in one year —
//  "BCA 2025–28", "B.Tech CSE 2024–28". Sections (A, B …) belong to it.
//  A student's cohort never changes (a year-back student moves cohort
//  explicitly), so it is the stable way to say "this year's 3rd years"
//  in any module: the current semester is worked out from the term.
// ─────────────────────────────────────────────────────────────────────
const sectionSchema = new mongoose.Schema({
  code:     { type: String, required: true, trim: true, uppercase: true, maxlength: 10 },   // "A"
  isActive: { type: Boolean, default: true },
}, { _id: false });

const cohortSchema = new mongoose.Schema({
  programme:     { type: mongoose.Schema.Types.ObjectId, ref: 'Programme', required: true },
  branch:        { type: String, default: '', trim: true, uppercase: true, maxlength: 20 },  // branch code, '' = none
  admissionYear: { type: Number, required: true, min: 1990, max: 2100 },
  name:          { type: String, default: '', trim: true, maxlength: 80 },                    // shown name, e.g. "BCA 2025–28"
  sections:      { type: [sectionSchema], default: [] },
  isActive:      { type: Boolean, default: true },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

cohortSchema.plugin(require('../services/tenant').plugin);   // college wall
cohortSchema.index({ org: 1, programme: 1, branch: 1, admissionYear: 1 }, { unique: true });

module.exports = mongoose.model('Cohort', cohortSchema);
