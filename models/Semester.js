const mongoose = require('mongoose');

const semesterSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true }, // e.g. "Odd Sem 2026-27"
  startDate: { type: Date,   default: Date.now },
  endDate:   { type: Date,   default: null },
  status:    { type: String, enum: ['active', 'archived'], default: 'active' },
  notes:     { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

semesterSchema.plugin(require('../services/tenant').plugin);   // college wall: every record + query belongs to one college
module.exports = mongoose.model('Semester', semesterSchema);
