// Test helper: one college that opens on the test server's addresses, and the
// rest of the test runs inside it (services/tenant.js) — like a real request.
const Organization = require('../models/Organization');
const tenant = require('../services/tenant');

// Older suites set students up with the batch join code, so the test college
// uses batch mode unless a suite asks for personal codes (extra.settings).
async function setup(extra = {}) {
  const org = await Organization.create({ name: 'Test College', shortName: 'TC', slug: 'test-college',
    hosts: ['127.0.0.1', 'localhost'], ...extra, settings: { studentSignup: 'batch', ...(extra.settings || {}) } });
  require('../middleware/org').forget();
  tenant.enter(org._id);
  return org;
}
module.exports = { setup };
