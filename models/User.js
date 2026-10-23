const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  role: {
    type: String,
    enum: ['superadmin', 'trainer', 'cotrainer'],
    default: 'trainer'
  },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Drop the auth middleware's cached copy whenever a user changes (services/userCache.js).
const forget = (doc) => require('../services/userCache').forget(doc?._id);
userSchema.post('save', forget);
userSchema.post('findOneAndUpdate', forget);
userSchema.post('findOneAndDelete', forget);
userSchema.post(['updateOne', 'updateMany', 'deleteOne', 'deleteMany'], () => require('../services/userCache').forget(null));

module.exports = mongoose.model('User', userSchema);
