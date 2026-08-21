const mongoose = require('mongoose');

const topicSchema = new mongoose.Schema({
  title:  { type: String, required: true, trim: true },
  order:  { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'in-progress', 'done'], default: 'pending' },
  // Filled when a daily log marks progress on this topic
  completedOn: { type: Date, default: null },
}, { _id: true });

const planSchema = new mongoose.Schema({
  batch:    { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true, unique: true },
  semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  title:    { type: String, default: 'Training Plan' },
  topics:   [topicSchema],
  updatedBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);
