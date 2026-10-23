const mongoose = require('mongoose');

// Notes taken in meetings.
//   scope 'day'   — daily review after classes (date = that day). Open notes keep
//                   showing on later days until someone marks them done.
//   scope 'cycle' — cycle review (period = the cycle period's deadline date, as
//                   on the Performance page), usually about one trainer.
// Visible to the admin, the note's author, the trainer it is about, and the
// trainers of its batch. Never anonymous, never hidden from the person concerned.
const meetingNoteSchema = new mongoose.Schema({
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  scope:    { type: String, enum: ['day', 'cycle'], required: true },
  date:     { type: String, default: null },     // 'YYYY-MM-DD' (scope day)
  period:   { type: String, default: null },     // 'YYYY-MM-DD' deadline period (scope cycle)
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', default: null },
  trainer:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  text:     { type: String, required: true, maxlength: 2000 },
  status:   { type: String, enum: ['open', 'done'], default: 'open' },
  createdBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  doneBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  doneAt:   { type: Date, default: null },
}, { timestamps: true });

meetingNoteSchema.index({ semester: 1, scope: 1, date: 1 });
meetingNoteSchema.index({ semester: 1, scope: 1, period: 1 });
meetingNoteSchema.index({ batch: 1, status: 1 });

module.exports = mongoose.model('MeetingNote', meetingNoteSchema);
