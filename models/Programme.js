const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
//  A programme the college runs (B.Tech, BCA, MCA …) — part of the core
//  academic structure every module shares (training, placement, prep,
//  workshops, academics). Branches live inside it (B.Tech → CSE, AIML …).
//  `aliases` are the other spellings imports and ERPs use ("BTECH",
//  "B Tech") so every spelling lands on ONE programme.
// ─────────────────────────────────────────────────────────────────────
const branchSchema = new mongoose.Schema({
  code:     { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },   // "CSE"
  name:     { type: String, required: true, trim: true, maxlength: 80 },                    // "Computer Science & Engineering"
  isActive: { type: Boolean, default: true },
}, { _id: false });

const programmeSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true, maxlength: 80 },               // "B.Tech"
  code:          { type: String, required: true, trim: true, uppercase: true, maxlength: 20 }, // "BTECH" (unique in the college)
  level:         { type: String, enum: ['certificate', 'diploma', 'ug', 'pg', 'doctoral', 'other'], default: 'ug' },
  durationYears: { type: Number, default: 4, min: 0.5, max: 8 },
  termsPerYear:  { type: Number, default: 2, min: 1, max: 4 },                               // semesters a year
  department:    { type: String, default: '', trim: true, maxlength: 80 },
  branches:      { type: [branchSchema], default: [] },
  aliases:       { type: [String], default: [] },                                            // normalised other spellings
  isActive:      { type: Boolean, default: true },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

programmeSchema.plugin(require('../services/tenant').plugin);   // college wall
programmeSchema.index({ org: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Programme', programmeSchema);
