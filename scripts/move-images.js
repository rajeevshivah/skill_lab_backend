// One-off: move images that are still inside database records (base64) into
// file storage (services/fileStore.js). Safe to run more than once — records
// that already have a storage key are skipped.
//
//   Set MONGODB_URI and the FILES_* variables, then:
//     node scripts/move-images.js            (shows what would move)
//     node scripts/move-images.js --apply    (moves them)
require('dotenv').config();
const mongoose = require('mongoose');
const tenant = require('../services/tenant');
const files = require('../services/fileStore');
const Organization = require('../models/Organization');
const Student = require('../models/Student');
const Cycle = require('../models/Cycle');
const ProjectSubmission = require('../models/ProjectSubmission');

const apply = process.argv.includes('--apply');

async function college(org) {
  const n = { photos: 0, top3: 0, screens: 0 };
  await tenant.run(org._id, async () => {
    for (const s of await Student.find({ 'photo.data': { $ne: null }, 'photo.key': null }).select('photo')) {
      n.photos++;
      if (apply) { s.photo = await files.store(s.photo, 'photos'); await s.save({ validateBeforeSave: false }); }
    }
    for (const c of await Cycle.find({ 'report.top3.photo.data': { $ne: null } })) {
      let changed = false;
      for (const t of c.report.top3) {
        if (!t.photo?.data || t.photo.key) continue;
        n.top3++; changed = true;
        if (apply) t.photo = await files.store(t.photo, 'top3');
      }
      if (apply && changed) { c.markModified('report.top3'); await c.save({ validateBeforeSave: false }); }
    }
    for (const x of await ProjectSubmission.find({ 'screenshot.data': { $ne: null }, 'screenshot.key': null }).select('+screenshot.data screenshot.contentType screenshot.key')) {
      n.screens++;
      if (apply) { x.screenshot = await files.store(x.screenshot, 'screens'); await x.save({ validateBeforeSave: false }); }
    }
  });
  return n;
}

(async () => {
  if (!files.enabled()) { console.log('File storage is not set up (FILES_* variables) — nothing to do.'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI);
  for (const org of await Organization.find().lean()) {
    const n = await college(org);
    console.log(`${org.name}: ${n.photos} photo(s), ${n.top3} Top 3 photo(s), ${n.screens} screenshot(s) ${apply ? 'moved' : 'to move'}`);
  }
  if (!apply) console.log('\nNothing changed. Run again with --apply to move them.');
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
