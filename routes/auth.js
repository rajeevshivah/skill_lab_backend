const express = require('express');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const tenant  = require('../services/tenant');
const { protect, superadminOnly, roleIn } = require('../middleware/auth');
const router  = express.Router();

// A staff token belongs to one college (org) — or to none for the platform owner's console.
// `v` = the user's tokenVersion: a password change or reset bumps it, and older
// sign-ins stop working at once (middleware/auth.js).
const signToken = (user, org) =>
  jwt.sign({ id: user._id, org: org || null, v: user.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '7d' });

// ── Login limits: per address and per email (services/throttle.js) ──
const loginLimit = require('../services/throttle').limiter({ perIp: 30, perAccount: 8 });
const MIN_PW = 10;
const pwProblem = (pw) => String(pw || '').length < MIN_PW ? `Password must be at least ${MIN_PW} characters.` : null;

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password required' });

    if (loginLimit.blocked(req, email))
      return res.status(429).json({ message: 'Too many failed attempts. Try again in 15 minutes.' });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user || !(await user.comparePassword(password))) {
      loginLimit.fail(req, email);
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.isActive) {
      loginLimit.fail(req, email);
      return res.status(401).json({ message: 'Account deactivated' });
    }

    // Signed in for the college of this web address (middleware/org.js).
    const org = tenant.currentOrg();
    const role = roleIn(user, org);
    if (!role) { loginLimit.fail(req, email); return res.status(401).json({ message: org ? 'Your account is not active for this college.' : 'This address is not linked to a college.' }); }

    loginLimit.clear(req, email);
    res.json({
      token: signToken(user, org),
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

// PUT /api/auth/password { current, password } — change my own password.
// Every other sign-in of mine ends; this one gets a fresh token.
router.put('/password', protect, async (req, res) => {
  try {
    const { current, password } = req.body || {};
    if (pwProblem(password)) return res.status(400).json({ message: pwProblem(password) });
    const user = await User.findById(req.user._id);
    if (!user || !(await user.comparePassword(String(current || '')))) return res.status(400).json({ message: 'Current password is wrong.' });
    user.password = password;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    res.json({ ok: true, token: signToken(user, tenant.currentOrg()) });
  } catch (err) { res.status(500).json({ message: 'Could not change the password.' }); }
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
    if (pwProblem(password)) return res.status(400).json({ message: pwProblem(password) });
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
    // The platform owner's account is changed only by the platform owner.
    if (user.platformOwner && !req.user.platformOwner)
      return res.status(403).json({ message: 'This is the platform owner\'s account. Only the platform owner can change it.' });
    if (password && pwProblem(password)) return res.status(400).json({ message: pwProblem(password) });

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
    if (password) { user.password = password; user.tokenVersion = (user.tokenVersion || 0) + 1; }   // re-hash; older sign-ins end
    user.markModified('memberships');
    await user.save();
    res.json({ user: view(user, org) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Sign out everywhere ─────────────────────────────────────────────
// Bumping tokenVersion makes every sign-in made before it stop working at once
// (middleware/auth.js, routes/student.js). AI connections use their own tokens
// and keep working (remove them on the Connect AI page if needed).

// PUT /api/auth/sign-out-others — end my other sign-ins; this device gets a fresh token
router.put('/sign-out-others', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    res.json({ ok: true, token: signToken(user, tenant.currentOrg()) });
  } catch (err) { res.status(500).json({ message: 'Could not sign out the other devices.' }); }
});

// POST /api/auth/users/:id/sign-out  (college admin) — end every sign-in of one person
router.post('/users/:id/sign-out', protect, superadminOnly, async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, ...User.inOrg(tenant.currentOrg()) });
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.platformOwner && !req.user.platformOwner)
      return res.status(403).json({ message: 'This is the platform owner\'s account. Only the platform owner can change it.' });
    if (String(user._id) === String(req.user._id))
      return res.status(400).json({ message: 'To sign yourself out of other devices use "Sign out other devices" in your account menu.' });
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    res.json({ ok: true, message: `${user.name} is signed out on every device.` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/auth/sign-out-all { staff, students }  (college admin)
// Everyone of THIS college signs in again. You stay signed in on this device.
// The platform owner and people who also work for another college are left
// alone (their sign-ins are shared with that college) — they are listed.
router.post('/sign-out-all', protect, superadminOnly, async (req, res) => {
  try {
    const org = tenant.currentOrg();
    const staff = req.body?.staff !== false, students = req.body?.students === true;
    if (!staff && !students) return res.status(400).json({ message: 'Choose staff, students or both.' });
    const out = { staff: 0, students: 0, skipped: [] };
    if (staff) {
      const users = await User.find(User.inOrg(org)).select('name email platformOwner memberships tokenVersion');
      const ids = [];
      for (const u of users) {
        if (String(u._id) === String(req.user._id)) continue;
        if (u.platformOwner) { out.skipped.push(`${u.name} (platform owner)`); continue; }
        if ((u.memberships || []).some(m => String(m.org) !== String(org))) { out.skipped.push(`${u.name} (also works with another college)`); continue; }
        ids.push(u._id);
      }
      if (ids.length) await User.updateMany({ _id: { $in: ids } }, { $inc: { tokenVersion: 1 } });
      out.staff = ids.length;
    }
    if (students) {
      const Student = require('../models/Student'), Person = require('../models/Person');
      const r = await Person.updateMany({ 'login.activatedAt': { $ne: null } }, { $inc: { 'login.tokenVersion': 1 } });
      await Student.updateMany({ 'login.tokenVersion': { $exists: true } }, { $inc: { 'login.tokenVersion': 1 } }).setOptions({ withDemo: true });   // older sign-ins too
      out.students = r.modifiedCount ?? r.nModified ?? 0;
    }
    res.json({ ok: true, ...out });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/auth/users/:id  (college admin) — removes them from THIS college
router.delete('/users/:id', protect, superadminOnly, async (req, res) => {
  try {
    const org = tenant.currentOrg();
    if (req.params.id === req.user._id.toString())
      return res.status(400).json({ message: 'Cannot delete yourself' });
    const target = await User.findOne({ _id: req.params.id, ...User.inOrg(org) });
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target.platformOwner && !req.user.platformOwner)
      return res.status(403).json({ message: 'This is the platform owner\'s account. Only the platform owner can change it.' });
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
module.exports.MIN_PW = MIN_PW;
