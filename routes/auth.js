const express = require('express');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const tenant  = require('../services/tenant');
const { protect, superadminOnly, roleIn } = require('../middleware/auth');
const router  = express.Router();

// A staff token belongs to one college (org) — or to none for the platform owner's console.
const signToken = (id, org) =>
  jwt.sign({ id, org: org || null }, process.env.JWT_SECRET, { expiresIn: '7d' });

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

    // Signed in for the college of this web address (middleware/org.js).
    const org = tenant.currentOrg();
    const role = roleIn(user, org);
    if (!role) { noteFailure(key); return res.status(401).json({ message: org ? 'Your account is not active for this college.' : 'This address is not linked to a college.' }); }

    attempts.delete(key);
    res.json({
      token: signToken(user._id, org),
      user: { id: user._id, name: user.name, email: user.email, role, platformOwner: !!user.platformOwner }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.json({ user: req.user });
});

// ── This college's staff ──────────────────────────────────────────
// A login is one person (email); their role and on/off switch are per college
// (User.memberships). Adding an email that already exists elsewhere just
// gives that person a membership here — their password stays theirs.
const view = (u, org) => {
  const m = u.membershipIn(org);
  return { _id: u._id, id: u._id, name: u.name, email: u.email, role: m?.role || null, isActive: !!(m?.isActive && u.isActive),
    otherColleges: (u.memberships || []).filter(x => String(x.org) !== String(org)).length, createdAt: u.createdAt };
};
const activeAdmins = async (org, notId) => (await User.find({ ...User.inOrg(org), isActive: true, _id: { $ne: notId } }).select('memberships'))
  .filter(u => { const m = u.membershipIn(org); return m && m.isActive && m.role === 'superadmin'; }).length;

// POST /api/auth/create-user  (college admin)
router.post('/create-user', protect, superadminOnly, async (req, res) => {
  try {
    const org = tenant.currentOrg();
    const { name, email, password, role = 'trainer' } = req.body;
    if (!User.ROLES.includes(role)) return res.status(400).json({ message: 'Unknown role' });
    const mail = String(email || '').toLowerCase().trim();
    const exists = await User.findOne({ email: mail });
    if (exists) {
      if (exists.membershipIn(org)) return res.status(400).json({ message: 'Email already exists' });
      exists.memberships.push({ org, role, isActive: true });
      await exists.save();
      return res.status(201).json({ message: 'This person already has a login (another college). They can now use it here too.',
        existing: true, user: { id: exists._id, name: exists.name, email: exists.email, role } });
    }
    const user = await User.create({ name, email: mail, password, role, memberships: [{ org, role, isActive: true }] });
    res.status(201).json({
      message: 'User created',
      user: { id: user._id, name: user.name, email: user.email, role }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/auth/users  (college admin) — this college's staff only
router.get('/users', protect, superadminOnly, async (req, res) => {
  try {
    const org = tenant.currentOrg();
    const users = await User.find(User.inOrg(org)).select('-password').sort('-createdAt');
    res.json({ users: users.map(u => view(u, org)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/auth/users/:id  (college admin)
router.patch('/users/:id', protect, superadminOnly, async (req, res) => {
  try {
    const org = tenant.currentOrg();
    const { name, role, isActive, password } = req.body;
    const user = await User.findOne({ _id: req.params.id, ...User.inOrg(org) });
    if (!user) return res.status(404).json({ message: 'User not found' });
    const m = user.membershipIn(org);
    if (role !== undefined && !User.ROLES.includes(role)) return res.status(400).json({ message: 'Unknown role' });

    // Never let the last active admin be demoted or switched off — that
    // locks everyone out of the admin screens with no way back in.
    const losingAdmin = m.role === 'superadmin' && ((role !== undefined && role !== 'superadmin') || isActive === false);
    if (losingAdmin && (await activeAdmins(org, user._id)) === 0)
      return res.status(400).json({ message: 'This is the only active superadmin. Promote someone else first.' });
    // A person who also works for another college owns their password and name.
    const shared = (user.memberships || []).some(x => String(x.org) !== String(org));
    if (shared && (password || (name !== undefined && name !== user.name)))
      return res.status(400).json({ message: 'This person also works with another college, so only they can change their name or password.' });

    if (name !== undefined)     user.name = name;
    if (role !== undefined)     m.role = role;
    if (isActive !== undefined) m.isActive = !!isActive;
    if (password)               user.password = password; // triggers re-hash
    user.markModified('memberships');
    await user.save();
    res.json({ user: view(user, org) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/auth/users/:id  (college admin) — removes them from THIS college
router.delete('/users/:id', protect, superadminOnly, async (req, res) => {
  try {
    const org = tenant.currentOrg();
    if (req.params.id === req.user._id.toString())
      return res.status(400).json({ message: 'Cannot delete yourself' });
    const target = await User.findOne({ _id: req.params.id, ...User.inOrg(org) });
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target.membershipIn(org).role === 'superadmin' && (await activeAdmins(org, target._id)) === 0)
      return res.status(400).json({ message: 'This is the only active superadmin. Promote someone else first.' });
    target.memberships = target.memberships.filter(x => String(x.org) !== String(org));
    if (!target.memberships.length && !target.platformOwner) await User.deleteOne({ _id: target._id });
    else await target.save();
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
