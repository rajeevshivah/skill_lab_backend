// Test helper: one college that opens on the test server's addresses, and the
// rest of the test runs inside it (services/tenant.js) — like a real request.
const Organization = require('../models/Organization');
const tenant = require('../services/tenant');

async function setup(extra = {}) {
  const org = await Organization.create({ name: 'Test College', shortName: 'TC', slug: 'test-college',
    hosts: ['127.0.0.1', 'localhost'], ...extra });
  require('../middleware/org').forget();
  tenant.enter(org._id);
  return org;
}
module.exports = { setup };
