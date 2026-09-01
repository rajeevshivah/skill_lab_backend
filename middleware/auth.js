const jwt  = require('jsonwebtoken');
const User = require('../models/User');
const Batch = require('../models/Batch');

exports.protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive)
      return res.status(401).json({ message: 'User not found or inactive' });

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

exports.restrictTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role))
    return res.status(403).json({ message: 'Access denied' });
  next();
};

exports.superadminOnly = (req, res, next) => {
  if (req.user.role !== 'superadmin')
    return res.status(403).json({ message: 'Superadmin only' });
  next();
};

exports.noCotrainer = (req, res, next) => {
  if (req.user.role === 'cotrainer')
    return res.status(403).json({ message: 'Co-trainers cannot delete records' });
  next();
};

// True if the user may write to this batch (superadmin, or an assigned trainer)
exports.canAccessBatch = async (user, batchId) => {
  if (user.role === 'superadmin') return true;
  const batch = await Batch.findById(batchId).select('trainers');
  if (!batch) return false;
  return batch.trainers.some(t => t.toString() === user._id.toString());
};

// The batch ids a user may READ.
// null = superadmin ("everything"); otherwise an array of ids.
exports.readableBatchIds = async (user) => {
  if (user.role === 'superadmin') return null;
  const mine = await Batch.find({ trainers: user._id }).select('_id');
  return mine.map(b => b._id);
};

// Mongo filter fragment limiting `field` to the batches a user may read.
// Honours an explicit ?batch=<id> while still refusing batches they don't own.
exports.scopeToReadableBatches = async (user, requestedBatchId, field = 'batch') => {
  const allowed = await exports.readableBatchIds(user);
  if (allowed === null) return requestedBatchId ? { [field]: requestedBatchId } : {};
  if (requestedBatchId) {
    const ok = allowed.some(id => id.toString() === requestedBatchId.toString());
    // An id they don't own resolves to "no batches", never to everything.
    return { [field]: ok ? requestedBatchId : null };
  }
  return { [field]: { $in: allowed } };
};
