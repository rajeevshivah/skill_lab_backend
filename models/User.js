const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const ROLES = ['superadmin', 'trainer', 'cotrainer', 'viewer'];

const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  // A person can work for several colleges (e.g. a Minicimex trainer). Their
  // role is per college — see memberships. `role` is only the default used
  // when a user is created inside a college; requests use the membership role.
  //   superadmin = the college's admin · trainer · cotrainer · viewer = management, read-only
  role: {
    type: String,
    enum: ROLES,
    default: 'trainer'
  },
  memberships: [{ _id: false,
    org:      { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    role:     { type: String, enum: ROLES, default: 'trainer' },
    isActive: { type: Boolean, default: true },
  }],
  // Platform owner (Minicimex): runs the owner console, can open any college.
  platformOwner: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },        // false = this login is off everywhere
}, { timestamps: true });

userSchema.index({ 'memberships.org': 1 });

// The membership of this user in a college (or null).
userSchema.methods.membershipIn = function (org) {
  return (this.memberships || []).find(m => String(m.org) === String(org)) || null;
};
// Users of one college: User.find(User.inOrg(org))  (check role / isActive per membership in code)
userSchema.statics.inOrg = (org) => ({ 'memberships.org': org });

// Created inside a college (website, AI tools, tests) without memberships → member of that college.
userSchema.pre('validate', function () {
  if (this.isNew && !(this.memberships || []).length) {
    const org = require('../services/tenant').currentOrg();
    if (org) this.memberships = [{ org, role: this.role || 'trainer', isActive: true }];
  }
});

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

userSchema.statics.ROLES = ROLES;
module.exports = mongoose.model('User', userSchema);
