const mongoose = require('mongoose');

// A holiday / no-class period (one day or a range), for all batches or chosen
// ones. When marked with mode 'shift', the planned classes from that day on
// were moved to each batch's next class days; `moves` and `cycleChanges`
// record exactly what changed so the holiday can be removed (undone) later.
const holidaySchema = new mongoose.Schema({
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  from:     { type: String, required: true },          // 'YYYY-MM-DD'
  to:       { type: String, required: true },          // 'YYYY-MM-DD' (same as from for one day)
  title:    { type: String, default: 'Holiday' },
  batches:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Batch' }],   // empty = every batch
  // shift = move classes forward · mark = move nothing · keep = move forward but keep the
  // project day (the class that no longer fits merges into the last one before it) ·
  // makeup = the day's classes happen on makeupDate instead (any day, e.g. a Saturday)
  mode:     { type: String, enum: ['shift', 'mark', 'keep', 'makeup'], default: 'shift' },
  makeupDate: { type: String, default: null },        // 'YYYY-MM-DD' (mode makeup)
  moves: [{ _id: false,
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle' },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch' },
    number: Number, from: String, to: String }],
  merges: [{ _id: false,                                // mode keep: what was merged, to undo it
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle' },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch' },
    into: Number, prevTitle: String, prevNotes: String, newTitle: String, newNotes: String,
    removed: [{ _id: false, number: Number, title: String, notes: String, date: String, time: String,
      trainer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } }] }],
  cycleChanges: [{ _id: false,
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle' },
    endFrom: Date, endTo: Date, projectFrom: Date, projectTo: Date, deadlineFrom: Date, deadlineTo: Date }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

holidaySchema.index({ semester: 1, from: 1 });

holidaySchema.plugin(require('../services/tenant').plugin);   // college wall: every record + query belongs to one college
module.exports = mongoose.model('Holiday', holidaySchema);
