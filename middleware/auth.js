const jwt  = require('jsonwebtoken');
const User = require('../models/User');
const Batch = require('../models/Batch');
const userCache = require('../services/userCache');
const tenant = require('../services/tenant');

// A person's role in one college: their active membership there; the platform
// owner is admin everywhere (and outside any college). null = no access.
exports.roleIn = (user, org) => {
  if (!user || !user.isActive) return null;
  if (!org) return user.platformOwner ? 'superadmin' : null;
  const m = (user.memberships || []).find(x => String(x.org) === String(org));
  if (m && m.isActive) return m.role;
  return user.platformOwner ? 'superadmin' : null;
};
exports.asRequestUser = (user, role, org) =>
  ({ ...(user.toObject ? user.toObject() : user), password: undefined, role, org: org || null, platformOwner: !!user.platformOwner });

// Who is calling, as which role, in which college (middleware/org.js set the college).
// A person's role is their membership in THIS college; the platform owner can
// open any college as its admin. "viewer" (management) can read everything and
// change nothing.
exports.protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.kind === 'student') return res.status(401).json({ message: 'Please sign in with a staff account' });
    let user = userCache.get(decoded.id);
    if (!user) {
      user = await User.findById(decoded.id).select('-password');
      if (user) userCache.set(decoded.id, user);
    }
    if (!user || !user.isActive)
      return res.status(401).json({ message: 'User not found or inactive' });
    if ((decoded.v || 0) !== (user.tokenVersion || 0))
      return res.status(401).json({ message: 'Your password was changed. Please sign in again.' });

    const org = tenant.currentOrg();
    const role = exports.roleIn(user, org);
    if (!role) return res.status(401).json({ message: org ? 'Your account is not active for this college.' : 'This address is not linked to a college.' });
    req.user = exports.asRequestUser(user, role, org);
    // the placement officer works only in placement (and the student list it needs) — never training
    if (role === 'placement' && !exports.PLACEMENT_PATHS.some(p => req.originalUrl.startsWith(p)))
      return res.status(403).json({ message: 'This is a placement account — it opens the placement section only.' });
    // (their own AI connection tokens are the one thing they may create/revoke)
    if (role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.originalUrl.startsWith('/api/tokens'))
      return res.status(403).json({ message: 'This is a read-only (management) account.' });
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

exports.PLACEMENT_PATHS = ['/api/placement', '/api/auth', '/api/tokens', '/api/people', '/api/academics'];
// placement module: admin and placement officers change; management reads
exports.placementStaff = (req, res, next) => ['superadmin', 'placement', 'viewer'].includes(req.user.role) ? next() : res.status(403).json({ message: 'Placement team only' });

// Admin and management (viewer) read every batch of the college.
exports.seesAll = (user) => user.role === 'superadmin' || user.role === 'viewer';

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
  if (exports.seesAll(user)) return null;
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
