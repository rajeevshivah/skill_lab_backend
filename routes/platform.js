// ─────────────────────────────────────────────────────────────────────
//  Owner console (Minicimex, `platformOwner` users only): the colleges on
//  the platform — web addresses, modules bought, plan, pause/resume — and
//  each college's first admin. Works across colleges (allOrgs).
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const User = require('../models/User');
const orgMw = require('../middleware/org');
const { protect } = require('../middleware/auth');
const router = express.Router();

router.use(protect, (req, res, next) => req.user.platformOwner ? next() : res.status(403).json({ message: 'Platform owner only' }));

const tempPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', b = crypto.randomBytes(12);
  let p = ''; for (let i = 0; i < 12; i++) p += chars[b[i] % chars.length];
  return `${p.slice(0, 4)}-${p.slice(4, 8)}-${p.slice(8)}`;
};
const pick = (body) => {
  const out = {};
  for (const k of ['name', 'shortName', 'programName', 'slug', 'hosts', 'status']) if (body[k] !== undefined) out[k] = body[k];
  if (body.modules) for (const m of Organization.MODULES) if (body.modules[m] !== undefined) out[`modules.${m}`] = !!body.modules[m];
  if (body.plan) for (const k of ['name', 'validUntil', 'seats', 'notes']) if (body.plan[k] !== undefined) out[`plan.${k}`] = body.plan[k];
  return out;
};
// a web address may open only one college
async function hostClash(hosts, notId) {
  if (!hosts) return null;
  const clean = hosts.map(orgMw.cleanHost).filter(Boolean);
  const other = await Organization.findOne({ hosts: { $in: clean }, ...(notId ? { _id: { $ne: notId } } : {}) }).select('name hosts');
  return other ? `${clean.find(h => other.hosts.includes(h))} already opens ${other.name}.` : null;
}
// numbers per college, straight from the collections (owner console only)
async function usage(ids) {
  const db = mongoose.connection.db, out = new Map(ids.map(id => [String(id), { students: 0, batches: 0, staff: 0 }]));
  const count = async (coll, key, match = {}) => {
    const rows = await db.collection(coll).aggregate([{ $match: { org: { $in: ids }, ...match } }, { $group: { _id: '$org', n: { $sum: 1 } } }]).toArray();
    for (const r of rows) if (out.has(String(r._id))) out.get(String(r._id))[key] = r.n;
  };
  await Promise.all([count('students', 'students', { demo: { $ne: true } }), count('batches', 'batches')]);
  const staff = await User.find({ 'memberships.org': { $in: ids } }).select('memberships').lean();
  for (const u of staff) for (const m of u.memberships) if (out.has(String(m.org)) && m.isActive) out.get(String(m.org)).staff++;
  return out;
}

// GET /api/platform/orgs
router.get('/orgs', async (req, res) => {
  try {
    const orgs = await Organization.find().sort('name').lean();
    const use = await usage(orgs.map(o => o._id));
    res.json({ orgs: orgs.map(o => ({ ...o, modules: Organization.modulesOf(o.modules), usage: use.get(String(o._id)) })), modules: Organization.MODULES });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/platform/orgs  { name, slug, hosts[], modules{}, plan{}, admin: { name, email } }
router.post('/orgs', async (req, res) => {
  try {
    const { admin } = req.body;
    if (!req.body.name || !req.body.slug) return res.status(400).json({ message: 'Name and short id (slug) are needed.' });
    if (await Organization.exists({ slug: String(req.body.slug).toLowerCase() })) return res.status(400).json({ message: 'That short id is taken.' });
    const clash = await hostClash(req.body.hosts);
    if (clash) return res.status(400).json({ message: clash });
    const org = new Organization({ createdBy: req.user._id });
    org.set(pick(req.body));
    await org.save();
    let adminOut = null;
    if (admin?.email) adminOut = await addAdmin(org, admin);
    orgMw.forget();
    res.status(201).json({ org, admin: adminOut });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// PATCH /api/platform/orgs/:id   (name, hosts, modules, status, plan …)
router.patch('/orgs/:id', async (req, res) => {
  try {
    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ message: 'College not found' });
    const clash = await hostClash(req.body.hosts, org._id);
    if (clash) return res.status(400).json({ message: clash });
    org.set(pick(req.body));
    await org.save();
    orgMw.forget();
    res.json({ org });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST /api/platform/orgs/:id/admins  { name, email } — a college admin (temporary password shown once)
async function addAdmin(org, { name, email }) {
  const mail = String(email).toLowerCase().trim();
  let u = await User.findOne({ email: mail });
  if (u) {
    const m = u.membershipIn(org._id);
    if (m) { m.role = 'superadmin'; m.isActive = true; } else u.memberships.push({ org: org._id, role: 'superadmin', isActive: true });
    u.markModified('memberships'); await u.save();
    return { id: u._id, name: u.name, email: u.email, existing: true };
  }
  const password = tempPassword();
  u = await User.create({ name: name || mail, email: mail, password, role: 'superadmin', memberships: [{ org: org._id, role: 'superadmin', isActive: true }] });
  return { id: u._id, name: u.name, email: u.email, temporaryPassword: password };
}
router.post('/orgs/:id/admins', async (req, res) => {
  try {
    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ message: 'College not found' });
    if (!req.body.email) return res.status(400).json({ message: 'Email needed' });
    res.status(201).json({ admin: await addAdmin(org, req.body) });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;
