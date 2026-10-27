// COLLEGE WALLS: two colleges on one server and one database. Nothing of one
// college may be seen or changed from the other — through the website, the
// student app or an AI connection — plus modules, management (viewer)
// accounts, paused colleges, shared trainers and the owner console.
//
//   node tests/tenant.js        (TEST_MONGO_URI=… to use a running database)
process.env.JWT_SECRET = 'test-secret';
delete process.env.DEFAULT_ORG_SLUG;
const mongoose = require('mongoose');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; fails.push(n); console.log('  FAIL', n, typeof x === 'string' ? x : JSON.stringify(x).slice(0, 300)); } };
const step = (t) => console.log('\n— ' + t);

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const M = (n) => require('../models/' + n);
  const tenant = require('../services/tenant');
  const Organization = M('Organization'), User = M('User');
  const app = require('../app');
  for (const n of ['User', 'Organization', 'Batch', 'Student', 'Semester', 'ApiToken']) await M(n).init();

  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, { host, token, body, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(host ? { 'X-Org-Host': host } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const A_HOST = 'lab.alpha.edu', B_HOST = 'lab.beta.edu';

  // ── two colleges, each with its own people and records ──
  const A = await Organization.create({ name: 'Alpha College', shortName: 'Alpha', slug: 'alpha', hosts: [A_HOST] });
  const B = await Organization.create({ name: 'Beta Institute', shortName: 'Beta', slug: 'beta', hosts: [`https://${B_HOST}/`] });
  const owner = await User.create({ name: 'Owner', email: 'owner@pramakra.in', password: 'longpassword1', platformOwner: true, memberships: [] });
  const mk = (org, name, email, role) => User.create({ name, email, password: 'longpassword1', role, memberships: [{ org: org._id, role, isActive: true }] });
  const aAdmin = await mk(A, 'Asha', 'asha@alpha.edu', 'superadmin');
  const aTr = await mk(A, 'Arun', 'arun@minicimex.in', 'trainer');
  const bAdmin = await mk(B, 'Bina', 'bina@beta.edu', 'superadmin');
  const seed = (org, fn) => tenant.run(org._id, fn);
  const [aSem, aBatch, aStu] = await seed(A, async () => {
    const s = await M('Semester').create({ name: 'Odd 2026', status: 'active' });
    const b = await M('Batch').create({ name: 'Full Stack', track: 'MERN', semester: s._id, trainers: [aTr._id] });
    const st = await M('Student').create({ name: 'Aman', roll: '1001', batch: b._id, semester: s._id, password: 'student-pass1' });
    return [s, b, st];
  });
  const [bSem, bBatch] = await seed(B, async () => {
    const s = await M('Semester').create({ name: 'Odd 2026', status: 'active' });
    const b = await M('Batch').create({ name: 'Data Science', track: 'Python', semester: s._id, trainers: [] });
    await M('Student').create({ name: 'Bela', roll: '2001', batch: b._id, semester: s._id, password: 'student-pass1' });
    return [s, b];
  });
  const login = (host, email) => http('POST', '/api/auth/login', { host, body: { email, password: 'longpassword1' } });

  step('The college wall itself');
  let threw = false;
  try { await tenant.run(null, async () => await M('Batch').find()); } catch (e) { threw = e instanceof tenant.NoCollege; }
  ok('a query outside any college is refused (never "all colleges")', threw);
  ok('records got their college automatically', String(aBatch.org) === String(A._id) && String(bBatch.org) === String(B._id));
  ok('host saved clean (no https, slash)', (await Organization.findById(B._id)).hosts[0] === B_HOST);
  threw = false;
  try { await tenant.run(A._id, async () => await M('Batch').updateOne({ _id: aBatch._id }, { $set: { org: B._id } })); } catch (e) { threw = true; }
  ok('a record cannot be moved to another college', threw);

  step('Signing in belongs to the web address');
  let r = await http('GET', '/api/org', { host: A_HOST });
  ok('/api/org names the college of the address', r.body.org?.name === 'Alpha College' && r.body.platform === 'Pramakra');
  r = await http('GET', '/api/org', { host: 'unknown.example.com' });
  ok('unknown address with several colleges → no college', r.status === 200 && r.body.org === null);
  r = await http('GET', '/api/batches', { host: 'unknown.example.com' });
  ok('college routes on an unknown address → 404', r.status === 404 || r.status === 401, r);
  r = await login(A_HOST, 'asha@alpha.edu');
  ok('Alpha admin signs in on Alpha', r.status === 200 && r.body.user.role === 'superadmin');
  const aTok = r.body.token;
  r = await login(B_HOST, 'asha@alpha.edu');
  ok('Alpha admin is refused on Beta', r.status === 401);
  const bTok = (await login(B_HOST, 'bina@beta.edu')).body.token;
  r = await http('GET', '/api/batches', { host: B_HOST, token: aTok });
  ok('an Alpha sign-in used on Beta\'s address is refused', r.status === 401 && /another college/.test(r.body.message));

  step('Reading and changing: only your own college');
  r = await http('GET', '/api/batches', { host: A_HOST, token: aTok });
  ok('Alpha sees only Alpha batches', r.status === 200 && r.body.batches.length === 1 && r.body.batches[0].name === 'Full Stack', r.body);
  r = await http('GET', `/api/batches/${bBatch._id}`, { host: A_HOST, token: aTok });
  ok('a Beta batch id from Alpha → not found', r.status === 404, r);
  r = await http('PATCH', `/api/batches/${bBatch._id}`, { host: A_HOST, token: aTok, body: { name: 'Hacked' } });
  const bNow = await tenant.run(B._id, async () => await M('Batch').findById(bBatch._id));
  ok('changing a Beta batch from Alpha does nothing', r.status === 404 && bNow.name === 'Data Science', r);
  r = await http('GET', `/api/students?batch=${bBatch._id}`, { host: A_HOST, token: aTok });
  ok('Beta students are not listed from Alpha', !(r.body?.students || []).some(s => s.name === 'Bela'), r.body);
  r = await http('GET', '/api/search?q=Bela', { host: A_HOST, token: aTok });
  ok('search from Alpha does not find Beta people', !JSON.stringify(r.body || {}).includes('Bela'));
  r = await http('PATCH', `/api/batches/${aBatch._id}`, { host: A_HOST, token: aTok, body: { trainers: [bAdmin._id] } });
  ok('a Beta person cannot be made trainer of an Alpha batch', r.status === 400, r);
  r = await http('GET', '/api/auth/users', { host: A_HOST, token: aTok });
  ok('staff list shows only Alpha staff', r.status === 200 && r.body.users.map(u => u.email).sort().join() === 'arun@minicimex.in,asha@alpha.edu', r.body);
  r = await http('GET', '/api/auth/users', { host: B_HOST, token: bTok });
  ok('…and Beta only Beta', r.body.users.length === 1 && r.body.users[0].email === 'bina@beta.edu');
  r = await http('PATCH', `/api/auth/users/${aTr._id}`, { host: B_HOST, token: bTok, body: { isActive: false } });
  ok('Beta admin cannot touch an Alpha trainer', r.status === 404);

  step('Students: one college each');
  r = await http('POST', '/api/student/login', { host: A_HOST, body: { roll: '2001', password: 'student-pass1' } });
  ok('a Beta roll cannot sign in on Alpha', r.status !== 200, r);
  r = await http('GET', '/api/cycles/halloffame', { host: B_HOST });
  ok('public Hall of Fame works per college', r.status === 200, r);

  step('Modules a college has bought');
  await Organization.updateOne({ _id: B._id }, { $set: { 'modules.hallOfFame': false, 'modules.ai': false } });
  require('../middleware/org').forget();
  r = await http('GET', '/api/cycles/halloffame', { host: B_HOST });
  ok('Hall of Fame off → 403 on Beta', r.status === 403 && r.body.module === 'hallOfFame');
  r = await http('GET', '/api/cycles/halloffame', { host: A_HOST });
  ok('…still on for Alpha', r.status === 200);
  r = await http('GET', '/api/cycles', { host: B_HOST, token: bTok });
  ok('other cycle screens unaffected', r.status === 200);
  r = await http('POST', '/api/tokens', { host: B_HOST, token: bTok, body: { name: 'x' } });
  ok('AI off → no AI tokens on Beta', r.status === 403);

  step('AI connections stay inside their college');
  r = await http('POST', '/api/tokens', { host: A_HOST, token: aTok, body: { name: 'Claude' } });
  const aiTok = r.body.token;
  const mcp = (tok, name, args = {}) => http('POST', '/mcp', { token: tok, headers: { Accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  r = await mcp(aiTok, 'list_batches');
  const listed = JSON.stringify(r.body?.result?.structuredContent || r.body);
  ok('AI token (no web address) sees only Alpha batches', listed.includes('Full Stack') && !listed.includes('Data Science'), r.body);
  const bAi = await tenant.run(B._id, async () => { const g = M('ApiToken').generate(); await M('ApiToken').create({ user: bAdmin._id, name: 'old', hash: g.hash, prefix: g.prefix }); return g.plain; });
  r = await mcp(bAi, 'list_batches');
  ok('AI module off → Beta\'s token is refused', r.status === 403, r);

  step('Management (viewer) accounts: see everything, change nothing');
  r = await http('POST', '/api/auth/create-user', { host: A_HOST, token: aTok, body: { name: 'Director', email: 'md@alpha.edu', password: 'longpassword1', role: 'viewer' } });
  ok('admin adds a viewer', r.status === 201, r);
  const vTok = (await login(A_HOST, 'md@alpha.edu')).body.token;
  r = await http('GET', '/api/batches', { host: A_HOST, token: vTok });
  ok('viewer sees every batch', r.status === 200 && r.body.batches.length === 1);
  r = await http('POST', '/api/batches', { host: A_HOST, token: vTok, body: { name: 'X', semester: aSem._id } });
  ok('viewer cannot create', r.status === 403);
  r = await http('POST', '/api/tokens', { host: A_HOST, token: vTok, body: { name: 'mine' } });
  ok('viewer may still make their own AI token', r.status === 201, r);
  r = await mcp(r.body.token, 'save_daily_log', { batch_id: String(aBatch._id), date: '2026-10-20', status: 'done' });
  ok('viewer\'s AI cannot write', r.body?.result?.isError || r.body?.error, r.body);

  step('One trainer, two colleges (e.g. a Minicimex trainer)');
  r = await http('POST', '/api/auth/create-user', { host: B_HOST, token: bTok, body: { name: 'Arun', email: 'ARUN@minicimex.in', password: 'otherpass123', role: 'trainer' } });
  ok('Beta adds an existing person → membership, not a new login', r.status === 201 && r.body.existing === true, r.body);
  ok('same password works on both addresses', (await login(A_HOST, 'arun@minicimex.in')).status === 200 && (await login(B_HOST, 'arun@minicimex.in')).status === 200);
  r = await http('PATCH', `/api/auth/users/${aTr._id}`, { host: B_HOST, token: bTok, body: { password: 'stolenpass123' } });
  ok('Beta cannot reset a shared person\'s password', r.status === 400);
  r = await http('DELETE', `/api/auth/users/${aTr._id}`, { host: B_HOST, token: bTok });
  ok('Beta removing him removes only Beta', r.status === 200 && (await login(B_HOST, 'arun@minicimex.in')).status === 401 && (await login(A_HOST, 'arun@minicimex.in')).status === 200);

  step('Last admin of a college is protected');
  r = await http('PATCH', `/api/auth/users/${bAdmin._id}`, { host: B_HOST, token: bTok, body: { role: 'trainer' } });
  ok('Beta\'s only admin cannot be demoted', r.status === 400);

  step('Paused college');
  await Organization.updateOne({ _id: B._id }, { $set: { status: 'suspended' } });
  require('../middleware/org').forget();
  r = await http('GET', '/api/batches', { host: B_HOST, token: bTok });
  ok('paused college → 403 with a clear message', r.status === 403 && r.body.suspended === true);
  r = await http('GET', '/api/org', { host: B_HOST });
  ok('…its sign-in page still knows it is paused', r.status === 200 && r.body.org.status === 'suspended');
  ok('Alpha unaffected', (await http('GET', '/api/batches', { host: A_HOST, token: aTok })).status === 200);

  step('Owner console (platform owner only)');
  r = await http('GET', '/api/platform/orgs', { host: A_HOST, token: aTok });
  ok('a college admin cannot open it', r.status === 403);
  const oTok = (await login('console.pramakra.in', 'owner@pramakra.in')).body?.token;
  ok('platform owner signs in outside any college', !!oTok);
  r = await http('GET', '/api/platform/orgs', { host: 'console.pramakra.in', token: oTok });
  ok('lists colleges with usage', r.status === 200 && r.body.orgs.length === 2 && r.body.orgs.find(o => o.slug === 'alpha').usage.students === 1, r.body);
  r = await http('POST', '/api/platform/orgs', { host: 'console.pramakra.in', token: oTok, body: { name: 'Gamma', slug: 'gamma', hosts: [A_HOST] } });
  ok('a web address cannot open two colleges', r.status === 400 && /already opens/.test(r.body.message));
  r = await http('POST', '/api/platform/orgs', { host: 'console.pramakra.in', token: oTok,
    body: { name: 'Gamma University', slug: 'gamma', hosts: ['lab.gamma.edu'], modules: { studentApp: false }, admin: { name: 'Gita', email: 'gita@gamma.edu' } } });
  ok('new college + its admin (temporary password once)', r.status === 201 && /^.{4}-.{4}-.{4}$/.test(r.body.admin.temporaryPassword) && r.body.org.modules.studentApp === false, r.body);
  const gPw = r.body.admin.temporaryPassword;
  r = await http('POST', '/api/auth/login', { host: 'lab.gamma.edu', body: { email: 'gita@gamma.edu', password: gPw } });
  ok('the new admin signs in on the new address', r.status === 200 && r.body.user.role === 'superadmin');
  const gTok = r.body.token;
  r = await http('GET', '/api/batches', { host: 'lab.gamma.edu', token: gTok });
  ok('…and starts empty', r.status === 200 && r.body.batches.length === 0);
  ok('student app off for Gamma', (await http('POST', '/api/student/login', { host: 'lab.gamma.edu', body: { roll: '1', password: 'x' } })).status === 403);
  r = await http('PATCH', `/api/platform/orgs/${B._id}`, { host: 'console.pramakra.in', token: oTok, body: { status: 'active' } });
  ok('owner resumes Beta', r.status === 200 && (await http('GET', '/api/batches', { host: B_HOST, token: bTok })).status === 200);
  r = await http('GET', '/api/batches', { host: A_HOST, token: (await login(A_HOST, 'owner@pramakra.in')).body.token });
  ok('owner can open any college as its admin', r.status === 200 && r.body.batches.length === 1);

  step('Moving an old single-college database');
  await mongoose.connection.db.collection('batches').insertOne({ name: 'Legacy', semester: aSem._id, trainers: [] });
  await mongoose.connection.db.collection('users').insertOne({ name: 'Old', email: 'old@x.com', password: 'x', role: 'trainer', isActive: true });
  await require('../services/orgMigration').migrate(() => {});
  ok('with several colleges nothing is guessed', !(await mongoose.connection.db.collection('batches').findOne({ name: 'Legacy' })).org);

  await mongoose.disconnect(); server.close(); if (mongod) await mongod.stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed:', fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
