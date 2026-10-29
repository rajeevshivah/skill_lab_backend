const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────
//  THE student — one record per real student per college, shared by every
//  module (training, placement, aptitude prep, workshops, academics …).
//
//  A training "Student" record is this person's place in ONE batch
//  (Student.person → here). One person can hold several places (two tracks,
//  a new batch next semester) and keeps one history across all four years.
//
//  Moving over in steps (see services/people.js):
//    now   — persons are made from the training records; name + roll are
//            copied here and refreshed from them; training still reads its own.
//    later — adding/editing writes here first, screens read from here,
//            and the student sign-in moves here (one login for all modules).
// ─────────────────────────────────────────────────────────────────────
const ID_TYPES = ['university', 'enrolment', 'admission', 'apaar', 'abc', 'other'];
const STATUS   = ['studying', 'yearBack', 'onLeave', 'left', 'passedOut'];

const personSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true, maxlength: 120 },
  roll:          { type: String, default: '', trim: true, maxlength: 40 },   // the college's main student number
  rollTemporary: { type: Boolean, default: false },                           // TMP-XXXXX until the real roll is known
  // other numbers the student is known by (university roll, APAAR / ABC id …)
  ids: { type: [new mongoose.Schema({
    type:  { type: String, enum: ID_TYPES, required: true },
    value: { type: String, required: true, trim: true, maxlength: 60 },
  }, { _id: false })], default: [] },

  // where they are in the college
  academic: {
    programme:  { type: mongoose.Schema.Types.ObjectId, ref: 'Programme', default: null },
    branch:     { type: String, default: '', trim: true, uppercase: true, maxlength: 20 },
    cohort:     { type: mongoose.Schema.Types.ObjectId, ref: 'Cohort', default: null },
    section:    { type: String, default: '', trim: true, uppercase: true, maxlength: 10 },
    semesterNo: { type: Number, default: null, min: 1, max: 16 },
    entry:      { type: String, enum: ['regular', 'lateral'], default: 'regular' },
  },
  status: { type: String, enum: STATUS, default: 'studying' },

  contact: {
    email: { type: String, default: '', trim: true, lowercase: true, maxlength: 120 },
    phone: { type: String, default: '', trim: true, maxlength: 20 },
  },
  links: {
    github:    { type: String, default: '', trim: true, maxlength: 200 },
    linkedin:  { type: String, default: '', trim: true, maxlength: 200 },
    portfolio: { type: String, default: '', trim: true, maxlength: 200 },
  },
  // the college's own extra fields (models/ProfileField.js): { key: value }
  custom: { type: mongoose.Schema.Types.Mixed, default: {} },

  demo:      { type: Boolean, default: false },                // review account (from a demo training record)
  source:    { type: String, enum: ['training', 'import', 'staff', 'self', 'erp'], default: 'staff' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true, minimize: false });

personSchema.plugin(require('../services/tenant').plugin);   // college wall
personSchema.index({ org: 1, roll: 1 });
personSchema.index({ org: 1, 'academic.cohort': 1, 'academic.section': 1 });
personSchema.index({ org: 1, 'academic.programme': 1 });

personSchema.statics.ID_TYPES = ID_TYPES;
personSchema.statics.STATUS = STATUS;

module.exports = mongoose.model('Person', personSchema);
