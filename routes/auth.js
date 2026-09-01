const express = require('express');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const { protect, superadminOnly } = require('../middleware/auth');
const router  = express.Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// ── Login throttling ──────────────────────────────────────────────
// In-memory, per-IP+email. Enough to stop password guessing against a single
// known admin address; a single dyno holds the counters, which is fine here.
const WINDOW_MS   = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map(); // key -> { count, first }

function throttleKey(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  return `${ip}|${String(req.body?.email || '').toLowerCase()}`;
}
function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function noteFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}
// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, v] of attempts) if (v.first < cutoff) attempts.delete(k);
}, WINDOW_MS).unref?.();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password required' });

    const key = throttleKey(req);
    if (tooManyAttempts(key))
      return res.status(429).json({ message: 'Too many failed attempts. Try again in 15 minutes.' });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user || !(await user.comparePassword(password))) {
      noteFailure(key);
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.isActive) {
      noteFailure(key);
      return res.status(401).json({ message: 'Account deactivated' });
    }

    attempts.delete(key);
    res.json({
      token: signToken(user._id),
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/create-user  (superadmin only)
router.post('/create-user', protect, superadminOnly, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ message: 'Email already exists' });

    const user = await User.create({ name, email, password, role });
    res.status(201).json({
      message: 'User created',
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/auth/users  (superadmin only)
router.get('/users', protect, superadminOnly, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort('-createdAt');
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/auth/users/:id  (superadmin only)
router.patch('/users/:id', protect, superadminOnly, async (req, res) => {
  try {
    const { name, role, isActive, password } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Never let the last active superadmin be demoted or switched off — that
    // locks everyone out of the admin screens with no way back in.
    const losingAdmin =
      (role !== undefined && role !== 'superadmin' && user.role === 'superadmin') ||
      (isActive === false && user.role === 'superadmin');
    if (losingAdmin) {
      const others = await User.countDocuments({
        role: 'superadmin', isActive: true, _id: { $ne: user._id },
      });
      if (others === 0)
        return res.status(400).json({ message: 'This is the only active superadmin. Promote someone else first.' });
    }

    if (name !== undefined)     user.name = name;
    if (role !== undefined)     user.role = role;
    if (isActive !== undefined) user.isActive = isActive;
    if (password)               user.password = password; // triggers re-hash
    await user.save();
    const out = user.toObject(); delete out.password;
    res.json({ user: out });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/auth/users/:id  (superadmin only)
router.delete('/users/:id', protect, superadminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString())
      return res.status(400).json({ message: 'Cannot delete yourself' });
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target.role === 'superadmin') {
      const others = await User.countDocuments({
        role: 'superadmin', isActive: true, _id: { $ne: target._id },
      });
      if (others === 0)
        return res.status(400).json({ message: 'This is the only active superadmin. Promote someone else first.' });
    }
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
