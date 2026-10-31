const mongoose = require('mongoose');

// A college (customer) on the platform. Everything a college owns carries its
// `org` id (services/tenant.js keeps every query inside one college).
//   hosts   — the web addresses that open this college (e.g. skilllab.sheat.ac.in)
//   modules — what the college has bought; a switched-off module disappears
//             from its menus and its API answers 403
//   status  — 'suspended' blocks the college (subscription ended), data kept
const MODULES = ['training', 'hallOfFame', 'studentApp', 'ai', 'placement'];

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
    placement:  { type: Boolean, default: false },   // drives, applications (sold alone or with training)
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
    // How students set up their sign-in the first time:
    //   personal — roll + their own one-time code (from the trainer's list); a classmate cannot claim it
    //   batch    — roll + the batch code shown in class (quicker, less safe)
    studentSignup: { type: String, enum: ['personal', 'batch'], default: 'personal' },
    // Who may put a NEW student into the college's student list (services/people.js):
    //   trainers — adding a student to a batch creates them if the roll is new (default)
    //   admin    — trainers can only add students already in the list (from the admin / an import)
    studentCreation: { type: String, enum: ['trainers', 'admin'], default: 'trainers' },
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
// Every module switch with its default filled in (a college saved before a module
// existed has no value for it — that means the module's default, e.g. placement off).
organizationSchema.statics.modulesOf = function (m = {}) {
  return Object.fromEntries(MODULES.map(k => [k, typeof m?.[k] === 'boolean' ? m[k] : !!organizationSchema.path(`modules.${k}`).defaultValue]));
};
// What the website may see about a college before anyone signs in.
organizationSchema.methods.publicView = function () {
  return { id: this._id, name: this.name, shortName: this.shortName || this.name, programName: this.programName,
    slug: this.slug, modules: this.modules, status: this.status };
};

module.exports = mongoose.model('Organization', organizationSchema);
