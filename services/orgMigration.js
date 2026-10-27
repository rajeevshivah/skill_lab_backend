// ─────────────────────────────────────────────────────────────────────
//  One-time move to colleges (safe to run on every start: it only fills gaps).
//   1. No college yet → create the first one from the environment
//      (BOOTSTRAP_ORG_NAME / _SHORT / _SLUG / _HOSTS; defaults are SHEAT's).
//   2. Exactly one college → every record without a college joins it.
//   3. Staff without memberships get one there, with their old role.
//   4. PLATFORM_OWNER_EMAIL (or, if unset, the first superadmin) becomes the
//      platform owner when there is none.
// ─────────────────────────────────────────────────────────────────────
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const User = require('../models/User');

// every model that carries a college (services/tenant.js plugin) — loaded by app.js
const collegeModels = () => mongoose.modelNames().map(n => mongoose.model(n)).filter(m => m.schema.path('org') && m.modelName !== 'User');

async function migrate(log = console.log) {
  const env = process.env;
  let orgs = await Organization.find().lean();
  if (!orgs.length) {
    const hosts = (env.BOOTSTRAP_ORG_HOSTS || ['skilllab.sheat.ac.in', env.FRONTEND_URL || ''].join(',')).split(',');
    const org = await Organization.create({
      name: env.BOOTSTRAP_ORG_NAME || 'SHEAT College of Engineering',
      shortName: env.BOOTSTRAP_ORG_SHORT || 'SHEAT',
      slug: env.BOOTSTRAP_ORG_SLUG || 'sheat', hosts,
    });
    log(`[colleges] created the first college: ${org.name} (${org.hosts.join(', ')})`);
    orgs = [org.toObject()];
  }
  if (orgs.length !== 1) return;          // with several colleges nothing is guessed
  const org = orgs[0]._id;

  for (const m of collegeModels()) {
    const r = await m.collection.updateMany({ org: { $exists: false } }, { $set: { org } });
    if (r.modifiedCount) log(`[colleges] ${m.collection.name}: ${r.modifiedCount} records joined the college`);
  }
  const loose = await User.find({ $or: [{ memberships: { $exists: false } }, { memberships: { $size: 0 } }] });
  for (const u of loose) { u.memberships = [{ org, role: u.role || 'trainer', isActive: true }]; await u.save(); }
  if (loose.length) log(`[colleges] ${loose.length} staff accounts joined the college`);

  if (!(await User.exists({ platformOwner: true }))) {
    const owner = env.PLATFORM_OWNER_EMAIL
      ? await User.findOne({ email: env.PLATFORM_OWNER_EMAIL.toLowerCase() })
      : await User.findOne({ role: 'superadmin' }).sort('createdAt');
    if (owner) { owner.platformOwner = true; await owner.save(); log(`[colleges] platform owner: ${owner.email}`); }
  }
}

module.exports = { migrate };
