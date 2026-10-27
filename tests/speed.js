// Speed guard — fails if a page goes back to "one query per batch/cycle".
// Counts database round trips per route (time depends on the machine; round
// trips are what make pages slow on a far-away database). Also checks the
// Hall of Fame photo handling, the auth cache, and that bulk scoring gives
// exactly the same scores as scoring one cycle at a time.
//
//   npm run test:speed
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const M = (n) => require('../models/' + n);
const perf = require('../services/performance');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x); } };

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
  }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri(), { monitorCommands: true });
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const college = await require('./college').setup();
  let trips = 0;
  mongoose.connection.getClient().on('commandStarted', () => trips++);
  require('../services/reqTiming').watch(mongoose.connection.getClient());

  // ── seed: the trip count must NOT grow with the number of batches/cycles ──
  const seed = async (nBatches) => {
    const admin = await M('User').create({ name: 'Admin', email: `a${nBatches}@x.com`, password: 'longpassword1', role: 'superadmin' });
    const t1 = await M('User').create({ name: 'T1', email: `t1-${nBatches}@x.com`, password: 'longpassword1', role: 'trainer' });
    await M('Semester').updateMany({}, { $set: { status: 'archived' } });
    const sem = await M('Semester').create({ name: 'Sem ' + nBatches, status: 'active' });
    const day = (o) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + o); return d; };
    const ymd = perf.dayYmd;
    const photo = Buffer.alloc(30 * 1024, 7).toString('base64');
    let firstCycle = null;
    for (let b = 0; b < nBatches; b++) {
      const batch = await M('Batch').create({ name: `B${nBatches}-${b}`, semester: sem._id, trainers: [t1._id] });
      const studs = await M('Student').insertMany(Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, roll: `${b}${i}`, batch: batch._id, semester: sem._id })));
      for (let c = 1; c <= 3; c++) {
        const start = day(-40 + c * 12), end = day(-40 + c * 12 + 10);
        const cyc = await M('Cycle').create({ batch: batch._id, semester: sem._id, number: c, startDate: start, endDate: end,
          status: c < 3 ? 'closed' : 'active', track: { tracked: true, trackedFrom: start, marks: c < 3 ? { at: end } : null },
          report: { top3: c < 3 ? [1, 2, 3].map(r => ({ rank: r, name: studs[r].name, roll: studs[r].roll, photo: { data: photo, contentType: 'image/jpeg' } })) : [] } });
        firstCycle ||= cyc;
        await M('CyclePlan').create({ cycle: cyc._id, batch: batch._id, semester: sem._id, classes: Array.from({ length: 5 }, (_, i) => ({ number: i + 1, title: 'T' + i, date: ymd(new Date(start.getTime() + i * 864e5)) })) });
        await M('CycleMark').insertMany(studs.map((s, i) => ({ cycle: cyc._id, batch: batch._id, semester: sem._id, student: s._id, status: 'evaluated', category: i % 2 ? 'excellent' : 'basic' })));
      }
      await M('DailyLog').insertMany(Array.from({ length: 20 }, (_, i) => ({ batch: batch._id, semester: sem._id, date: day(-30 + i), loggedBy: t1._id, firstLoggedBy: t1._id, status: 'done', attendanceTaken: i % 3 > 0, attendance: studs.map(s => ({ student: s._id, present: true })) })));
    }
    return { admin, t1, sem, firstCycle };
  };

  const app = require('../app');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const get = async (path, token) => {
    trips = 0;
    const r = await fetch(base + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, trips, body: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })(), headers: r.headers };
  };
  const ROUTES = (s) => [
    ['/performance', s.admin], ['/meeting/review', s.admin], ['/meeting/day', s.admin], ['/cycleplans/board', s.admin],
    ['/logs/oversight', s.admin], ['/cycles/halloffame', null], ['/cycles', s.admin],
  ];

  console.log('\n— round trips do not grow with the number of batches');
  const small = await seed(2);
  const tripsSmall = {};
  for (const [p, u] of ROUTES(small)) { await get(p, T(u || small.admin)); tripsSmall[p] = (await get(p, u && T(u))).trips; }
  const big = await seed(8);
  for (const [p, u] of ROUTES(big)) {
    await get(p, u && T(u));                // warm the auth cache
    const r = await get(p, u && T(u));
    // /logs/oversight sends one tiny "last log" lookup per batch, all in parallel (a single wait) —
    // allowed to grow by one query per extra batch, nothing more.
    const extra = p === '/logs/oversight' ? 6 : 0;
    ok(`${p}: ${r.trips} round trips with 8 batches (2 batches: ${tripsSmall[p]})`, r.status === 200 && r.trips <= tripsSmall[p] + 1 + extra, `status ${r.status}`);
  }

  console.log('\n— round-trip budgets (signed in, warm)');
  const budget = { '/performance': 14, '/meeting/review': 26, '/meeting/day': 12, '/cycleplans/board': 12, '/logs/oversight': 16, '/cycles/halloffame': 4, '/cycles': 3 };
  for (const [p, u] of ROUTES(big)) {
    const r = await get(p, u && T(u));
    ok(`${p} ≤ ${budget[p]} round trips (is ${r.trips})`, r.trips <= budget[p]);
  }

  console.log('\n— bulk scoring = one-by-one scoring');
  const cycles = await M('Cycle').find({ semester: big.sem._id });
  const bulk = await perf.scoreCycles(cycles);
  let same = true;
  for (const c of cycles) {
    const one = await perf.scoreCycle(c);
    if (JSON.stringify(one) !== JSON.stringify(bulk.get(String(c._id)))) { same = false; console.log('    differs:', c._id); }
  }
  ok(`${cycles.length} cycles scored identically`, same);

  console.log('\n— Hall of Fame: one request, no inline photos, cacheable photo URLs');
  let r = await get('/cycles/halloffame');
  ok('without ?semester → active semester + semester list', String(r.json.semester) === String(big.sem._id) && r.json.semesters?.length === 2);
  ok('one cycle per batch', r.json.cycles.length === 8);
  const ph = r.json.cycles[0].top3[0].photo;
  ok('photo is a URL, not image data', typeof ph === 'string' && ph.startsWith('/cycles/') && !ph.startsWith('data:'), ph);
  ok('response is small (no photo data inside)', r.body.length < 20 * 1024, `${r.body.length} bytes`);
  ok('board answer may be cached briefly', /max-age=60/.test(r.headers.get('cache-control') || ''));
  const img = await get(ph.replace(/^\//, '/'));
  ok('photo URL serves the image', img.status === 200 && img.headers.get('content-type') === 'image/jpeg' && img.body.length === 30 * 1024);
  ok('photo cached for a year (URL changes when the cycle changes)', /immutable/.test(img.headers.get('cache-control') || ''));
  ok('unknown photo → 404', (await get(`/cycles/${big.firstCycle._id}/photo/9`)).status === 404);
  ok('bad id → 404', (await get('/cycles/nope/photo/1')).status === 404);
  r = await get(`/cycles/halloffame?semester=${small.sem._id}`);
  ok('?semester picks that semester (no list sent)', r.json.cycles.length === 2 && !r.json.semesters);
  r = await get('/cycles', T(big.admin));
  ok('cycles list carries no photo data', !r.body.includes('"data":"') && r.json.cycles.length > 0);
  r = await get(`/cycles/${big.firstCycle._id}`, T(big.admin));
  ok('cycle report still gets its photos (to edit them)', !!r.json.cycle.report.top3[0].photo?.data);

  console.log('\n— sign-in check is cached, but changes apply at once');
  const tok = T(big.t1);
  await get('/auth/me', tok);
  r = await get('/auth/me', tok);
  ok('repeat /auth/me needs no database trip', r.status === 200 && r.trips === 0, `${r.trips} trips`);
  const u = await M('User').findById(big.t1._id); u.isActive = false; await u.save();
  r = await get('/auth/me', tok);
  ok('deactivated user is refused immediately', r.status === 401);
  await M('User').updateOne({ _id: big.t1._id }, { $set: { isActive: true } });
  r = await get('/auth/me', tok);
  ok('re-activated (updateOne) applies immediately', r.status === 200);
  await M('User').findByIdAndUpdate(big.t1._id, { 'memberships.0.role': 'superadmin' });   // role is per college
  r = await get('/auth/me', tok);
  ok('role change (findByIdAndUpdate) applies immediately', r.json?.user?.role === 'superadmin');

  console.log('\n— gzip + timing header + health');
  r = await fetch(base + '/performance', { headers: { Authorization: 'Bearer ' + T(big.admin), 'Accept-Encoding': 'gzip' } });
  ok('JSON answers are gzipped', r.headers.get('content-encoding') === 'gzip');
  ok('Server-Timing header present', /db;dur=\d+;desc="\d+ queries", app;dur=\d+/.test(r.headers.get('server-timing') || ''), r.headers.get('server-timing'));
  r = await get('/health?db=1');
  ok('health reports database ping', r.status === 200 && typeof r.json.db?.pingMs === 'number', JSON.stringify(r.json));
  r = await fetch(base.replace('/api', '') + '/mcp', { method: 'POST', headers: { 'Accept-Encoding': 'gzip', 'Content-Type': 'application/json' }, body: '{}' });
  ok('/mcp answers are never gzipped (streams)', r.headers.get('content-encoding') !== 'gzip');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
