const mongoose = require('mongoose');

// A college (customer) on the platform. Everything a college owns carries its
// `org` id (services/tenant.js keeps every query inside one college).
//   hosts   — the web addresses that open this college (e.g. skilllab.sheat.ac.in)
//   modules — what the college has bought; a switched-off module disappears
//             from its menus and its API answers 403
//   status  — 'suspended' blocks the college (subscription ended), data kept
const MODULES = ['training', 'hallOfFame', 'studentApp', 'ai'];

const organizationSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },          // "SHEAT College of Engineering"
  shortName:   { type: String, default: '', trim: true },             // "SHEAT"
  programName: { type: String, default: 'Skill Lab', trim: true },    // what the college calls the program
  slug:        { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9][a-z0-9-]{1,40}$/ },
  hosts:       { type: [String], default: [] },                       // lowercase host names, no port
  modules: {
    training:   { type: Boolean, default: true },
    hallOfFame: { type: Boolean, default: true },
    studentApp: { type: Boolean, default: true },
    ai:         { type: Boolean, default: true },
  },
  status:      { type: String, enum: ['active', 'suspended'], default: 'active' },
  plan: {
    name:       { type: String, default: '' },
    validUntil: { type: Date, default: null },
    seats:      { type: Number, default: null },       // student seats bought
    notes:      { type: String, default: '' },
  },
  // College-level choices the admin can change (Settings)
  settings: {
    // Top students (services/topStudents.js): weights of the score out of 100,
    // and the cut-offs for the "Good" and "Excellent" labels.
    studentScore: {
      marks:      { type: Number, default: 60, min: 0, max: 100 },
      attendance: { type: Number, default: 25, min: 0, max: 100 },
      projects:   { type: Number, default: 15, min: 0, max: 100 },
      good:       { type: Number, default: 65, min: 0, max: 100 },
      excellent:  { type: Number, default: 80, min: 0, max: 100 },
    },
  },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

organizationSchema.index({ hosts: 1 });
organizationSchema.path('hosts').set(list => [...new Set((list || []).map(h => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[:/].*$/, '')).filter(Boolean))]);

organizationSchema.statics.MODULES = MODULES;
// What the website may see about a college before anyone signs in.
organizationSchema.methods.publicView = function () {
  return { id: this._id, name: this.name, shortName: this.shortName || this.name, programName: this.programName,
    slug: this.slug, modules: this.modules, status: this.status };
};

module.exports = mongoose.model('Organization', organizationSchema);
