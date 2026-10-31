const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
//  A placement drive: one company hiring for one role (placement module).
//
//  audience — who SEES it: programmes / branches / passing years (empty = all)
//  rules    — who may APPLY: conditions on profile fields, e.g.
//             { field: 'cgpa', op: 'gte', value: 6.5 }   (services/eligibility.js)
//  verifiedOnly — only values the college has verified count
//  questions    — asked only for this drive ("Willing to relocate?")
//  slug         — the share link: /d/<slug>
// ─────────────────────────────────────────────────────────────────────
const questionSchema = new mongoose.Schema({
  key:      { type: String, required: true, match: /^[a-z][a-z0-9_]{0,29}$/ },
  label:    { type: String, required: true, trim: true, maxlength: 160 },
  type:     { type: String, enum: ['text', 'number', 'select', 'boolean', 'url'], default: 'text' },
  options:  { type: [String], default: [] },
  required: { type: Boolean, default: false },
}, { _id: false });

const ruleSchema = new mongoose.Schema({
  field: { type: String, required: true, maxlength: 40 },        // a profile field key (cgpa, tenth_percent …) or 'semesterNo'
  op:    { type: String, enum: ['gte', 'lte', 'eq'], required: true },
  value: { type: Number, required: true },
}, { _id: false });

const driveSchema = new mongoose.Schema({
  company:     { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  title:       { type: String, required: true, trim: true, maxlength: 120 },     // the role, e.g. "Graduate Engineer Trainee"
  description: { type: String, default: '', maxlength: 20000 },                 // the JD text
  jd:          { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },   // the JD file, if any
  ctc: {
    text: { type: String, default: '', trim: true, maxlength: 80 },             // as the company wrote it: "₹6–8 LPA + bonus"
    min:  { type: Number, default: null },                                      // LPA, for sorting and reports
    max:  { type: Number, default: null },
  },
  location:  { type: String, default: '', trim: true, maxlength: 120 },
  mode:      { type: String, enum: ['onCampus', 'virtual', 'offCampus', 'pool'], default: 'onCampus' },
  bond:      { type: String, default: '', trim: true, maxlength: 200 },
  schedule:  { type: String, default: '', trim: true, maxlength: 500 },         // "Test 8 Nov, interviews 10 Nov"
  applyBy:   { type: Date, required: true },
  audience: {
    programmes:   { type: [mongoose.Schema.Types.ObjectId], ref: 'Programme', default: [] },
    branches:     { type: [String], default: [] },
    passingYears: { type: [Number], default: [] },
  },
  rules:         { type: [ruleSchema], default: [] },
  verifiedOnly:  { type: Boolean, default: false },
  resumeRequired:{ type: Boolean, default: true },
  questions:     { type: [questionSchema], default: [] },
  status:        { type: String, enum: ['draft', 'published', 'closed'], default: 'draft' },
  slug:          { type: String, required: true, lowercase: true, trim: true, match: /^[a-z0-9-]{3,60}$/ },
  publicPreview: { type: Boolean, default: true },     // the shared link may show company, role and last date before sign-in
  opens:         { type: Number, default: 0 },         // times the shared link was opened by a student
  publishedAt:   { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

driveSchema.plugin(require('../services/tenant').plugin);   // college wall
driveSchema.index({ org: 1, slug: 1 }, { unique: true });
driveSchema.index({ org: 1, status: 1, applyBy: -1 });

module.exports = mongoose.model('Drive', driveSchema);
