const mongoose = require('mongoose');

// A company that hires from the college (placement module). One record per
// company per college; its drives point here.
const contactSchema = new mongoose.Schema({
  name:  { type: String, default: '', trim: true, maxlength: 80 },
  email: { type: String, default: '', trim: true, lowercase: true, maxlength: 120 },
  phone: { type: String, default: '', trim: true, maxlength: 20 },
  role:  { type: String, default: '', trim: true, maxlength: 60 },   // "HR", "Campus lead"
}, { _id: false });

const companySchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true, maxlength: 120 },
  website:  { type: String, default: '', trim: true, maxlength: 200 },
  industry: { type: String, default: '', trim: true, maxlength: 80 },
  about:    { type: String, default: '', trim: true, maxlength: 2000 },
  contacts: { type: [contactSchema], default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

companySchema.plugin(require('../services/tenant').plugin);   // college wall
companySchema.index({ org: 1, name: 1 });

module.exports = mongoose.model('Company', companySchema);
