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
  mode:     { type: String, enum: ['shift', 'mark'], default: 'shift' },
  moves: [{ _id: false,
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle' },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch' },
    number: Number, from: String, to: String }],
  cycleChanges: [{ _id: false,
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle' },
    endFrom: Date, endTo: Date, projectFrom: Date, projectTo: Date, deadlineFrom: Date, deadlineTo: Date }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

holidaySchema.index({ semester: 1, from: 1 });

module.exports = mongoose.model('Holiday', holidaySchema);
