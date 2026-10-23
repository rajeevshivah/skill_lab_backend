const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true }, // "BTech 3rd Sem Combined", "MERN Track"
  semester:    { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  // Free-text description of who is in it, for reference
  composition: { type: String, default: '' }, // "BTech 3rd Sem Sec A + Sec B"
  // Track/stream label (optional) — e.g. MERN, Spring Boot, Data Analysis, C++
  track:       { type: String, default: '' },
  // One or more trainers assigned to this batch
  trainers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isActive:    { type: Boolean, default: true },
  // Once the roster is finalised (track segregation done), attendance averages
  // become "true" instead of provisional.
  rosterLocked:{ type: Boolean, default: false },
  rosterLockedAt: { type: Date, default: null },
  // Code the trainer shows in class; a student needs it (with their roll number)
  // to set up their sign-in the first time.
  joinCode:    { type: String, default: null },
  // Weekly timetable: the weekdays this batch has class (0 Sun … 6 Sat).
  // Used to move classes to the next class day when a holiday is marked.
  // Empty = not set yet (the Settings page shows a guess from the class plans).
  schedule:    { days: { type: [Number], default: [] } },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

batchSchema.index({ semester: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Batch', batchSchema);
