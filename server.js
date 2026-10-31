require('dotenv').config();
const mongoose  = require('mongoose');
const User      = require('./models/User');
const app       = require('./app');

// ── Connect DB & seed superadmin ──────────────────────────────────
async function start() {
  await mongoose.connect(process.env.MONGODB_URI, { monitorCommands: true });
  require('./services/reqTiming').watch(mongoose.connection.getClient());
  console.log('MongoDB connected');

  // Colleges: create the first one and move old records into it (only fills gaps).
  await require('./services/orgMigration').migrate();
  // Student sign-ins live on the student's main record now: copy any older per-batch ones over (only fills gaps).
  try { const r = await require('./services/studentAccess').moveLogins({ all: true }); if (r.moved) console.log(`[students] ${r.moved} sign-ins moved to the main record`); }
  catch (e) { console.error('[students] moving sign-ins:', e.message); }

  // Seed the first superadmin ONLY when the database has none AND a password is
  // supplied through the environment. No credential is hardcoded here, and
  // nothing is printed to the logs — a deploy log is not a private place.
  // They become the platform owner and admin of the first college.
  if (!(await User.exists({ platformOwner: true }))) {
    const seedEmail    = process.env.SEED_ADMIN_EMAIL;
    const seedPassword = process.env.SEED_ADMIN_PASSWORD;
    if (seedEmail && seedPassword && seedPassword.length >= 10) {
      const first = await require('./models/Organization').findOne().sort('createdAt');
      await User.create({
        name: process.env.SEED_ADMIN_NAME || 'Super Admin',
        email: seedEmail, password: seedPassword, role: 'superadmin', platformOwner: true,
        memberships: first ? [{ org: first._id, role: 'superadmin', isActive: true }] : [],
      });
      console.log(`Seeded the platform owner (${seedEmail}). Remove SEED_ADMIN_PASSWORD from the environment now.`);
    } else {
      console.warn(
        'No platform owner exists and no valid seed credentials were provided. ' +
        'Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (10+ characters), restart once, then remove them.'
      );
    }
  }

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch(console.error);
