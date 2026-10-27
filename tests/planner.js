// Cycle planner — the one way cycles are created.   npm run test:planner
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const User = require('../models/User'), Semester = require('../models/Semester'), Batch = require('../models/Batch');
const Cycle = require('../models/Cycle'), CyclePlan = require('../models/CyclePlan'), Holiday = require('../models/Holiday');
const perf = require('../services/performance');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x); } };
let base;
const http = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const college = await require('./college').setup();
  const app = express(); app.use(express.json());
  app.use('/api/cycles', require('../routes/cycles'));
  app.use('/api/cycleplans', require('../routes/cycleplans'));
  app.use('/api/settings', require('../routes/settings'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = await User.create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const lucky = await User.create({ name: 'Lucky', email: 'l@x.com', password: 'longpassword1', role: 'trainer' });
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const sem = await Semester.create({ name: 'Even', status: 'active' });
  const dev = await Batch.create({ name: 'Dev Core', semester: sem._id, trainers: [lucky._id], schedule: { days: [1, 2, 3] } });
  const bca1 = await Batch.create({ name: 'BCA 1st', semester: sem._id, trainers: [lucky._id], schedule: { days: [1, 3] } });
  const bt1 = await Batch.create({ name: 'BTech 1st', semester: sem._id, trainers: [lucky._id], schedule: { days: [2, 4] } });
  const unset = await Batch.create({ name: 'No Timetable', semester: sem._id, trainers: [] });
  // Dev Core already has Cycle 4 (classes up to 46)
  const c4 = await Cycle.create({ batch: dev._id, semester: sem._id, number: 4, startDate: perf.ymdToDay('2027-02-01'), endDate: perf.ymdToDay('2027-02-26') });
  await CyclePlan.create({ cycle: c4._id, batch: dev._id, semester: sem._id, classes: [{ number: 46, title: 'Project', date: '2027-02-24' }] });

  // Mon 1 Mar 2027 → Fri 19 Mar; holiday Wed 10 Mar for all
  const body = {
    groups: [
      { name: '3rd sem', batchIds: [String(dev._id)], start: '2027-03-01', end: '2027-03-19', projectDay: '2027-03-16' },
      { name: '1st year', batchIds: [String(bca1._id), String(bt1._id)], start: '2027-03-01', end: '2027-03-19', projectDays: { [String(bca1._id)]: '2027-03-17', [String(bt1._id)]: '2027-03-18' } },
    ],
    holidays: [{ from: '2027-03-10', to: '2027-03-10', title: 'Annual function' }],
  };

  console.log('\n— preview');
  let r = await http('POST', '/api/cycles/planner/preview', { token: T(lucky), body });
  ok('trainers cannot plan cycles', r.status === 403);
  r = await http('POST', '/api/cycles/planner/preview', { token: T(admin), body });
  const d = r.body.batches?.find(b => b.batch === 'Dev Core'), a = r.body.batches?.find(b => b.batch === 'BCA 1st'), t = r.body.batches?.find(b => b.batch === 'BTech 1st');
  ok('preview ok', r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 400));
  ok('Dev Core: Cycle 5, classes from 47', d.number === 5 && d.firstClass === 47, JSON.stringify(d));
  ok('Dev Core: Mon–Wed minus the holiday = 8 class days', d.classDays.length === 8 && !d.classDays.includes('2027-03-10'), JSON.stringify(d.classDays));
  ok('holiday listed for the batch', d.holidays.some(h => h.date === '2027-03-10'));
  ok('Dev Core: 1 class day after the project day → warning', d.warnings.some(w => /after the project day/.test(w)), JSON.stringify(d.warnings));
  ok('1st year: per-batch project days', a.projectDay === '2027-03-17' && t.projectDay === '2027-03-18');
  ok('BCA 1st: Mon/Wed minus holiday = 5 days, Cycle 1, class 1', a.classDays.length === 5 && a.number === 1 && a.firstClass === 1, JSON.stringify(a));

  console.log('\n— things that would break later are errors');
  const bad = async (g, re, label) => {
    const x = await http('POST', '/api/cycles/planner/preview', { token: T(admin), body: { groups: g } });
    const msg = JSON.stringify(x.body);
    ok(label, x.body.ok === false && re.test(msg), msg.slice(0, 300));
  };
  await bad([{ batchIds: [String(bt1._id)], start: '2027-03-01', end: '2027-03-19', projectDay: '2027-03-17' }], /not one of this batch's class days/, 'project day on a non-class day');
  await bad([{ batchIds: [String(unset._id)], start: '2027-03-01', end: '2027-03-19' }], /No class days set|timetable/, 'batch without a timetable');
  await bad([{ batchIds: [String(dev._id)], start: '2027-02-20', end: '2027-03-05' }], /Overlaps Cycle 4/, 'overlap with an existing cycle');
  await bad([{ batchIds: [String(dev._id)], start: '2027-03-01', end: '2027-03-05' }, { batchIds: [String(dev._id)], start: '2027-03-08', end: '2027-03-12' }], /one group only/, 'batch in two groups');
  await bad([{ batchIds: [String(dev._id)], start: '2027-03-05', end: '2027-03-01' }], /end date is before/, 'end before start');
  await Batch.updateOne({ _id: unset._id }, { $set: { 'schedule.days': [] } });
  r = await http('POST', '/api/cycles/planner', { token: T(admin), body: { groups: [{ batchIds: [String(bt1._id)], start: '2027-03-01', end: '2027-03-19', projectDay: '2027-03-17' }] } });
  ok('create refused while there are errors', r.status === 400 && (await Cycle.countDocuments({ batch: bt1._id })) === 0);

  console.log('\n— create');
  r = await http('POST', '/api/cycles/planner', { token: T(admin), body });
  ok('created 3 cycles + 1 holiday', r.status === 201 && r.body.created.length === 3 && r.body.holidays === 1, JSON.stringify(r.body));
  const c5 = await Cycle.findOne({ batch: dev._id, number: 5 });
  ok('cycle tracked from now with project day', c5.track.tracked && Math.abs(c5.track.trackedFrom - Date.now()) < 60000 && perf.dayYmd(c5.track.projectDate) === '2027-03-16');
  const p5 = await CyclePlan.findOne({ cycle: c5._id }).lean();
  ok('dated rows 47–54, empty topics except the project day', p5.classes.length === 8 && p5.classes[0].number === 47 && p5.classes[0].date === '2027-03-01'
    && p5.classes.filter(k => k.title).length === 1 && p5.classes.find(k => k.date === '2027-03-16').title === 'Cycle 5 project day', JSON.stringify(p5.classes));
  ok('history says it came from the planner', /cycle planner/.test(p5.changes[0].text));
  ok('no plan credit yet (topics empty)', !c5.track.plan?.at);
  ok('holiday saved for all batches', (await Holiday.findOne({ title: 'Annual function' })).batches.length === 0);
  r = await http('PATCH', `/api/cycleplans/${c5._id}/class/47`, { token: T(lucky), body: { title: 'Trees' } });
  ok('trainer fills topics in the dated rows', r.status === 200);
  r = await http('POST', '/api/cycles/planner', { token: T(admin), body });
  ok('running the same plan again is refused (overlap)', r.status === 400 && /Overlaps/.test(r.body.message), JSON.stringify(r.body));

  console.log('\n— existing plans touched by a new holiday are reported');
  r = await http('POST', '/api/cycles/planner/preview', { token: T(admin), body: { groups: [{ batchIds: [String(unset._id)], start: '2027-04-05', end: '2027-04-09' }], holidays: [{ from: '2027-03-01', to: '2027-03-01', title: 'X' }] } });
  ok('classes already planned on a new holiday are listed', r.body.affected.some(x => x.batch === 'Dev Core' && x.number === 47), JSON.stringify(r.body.affected));

  console.log('\n— old ways to create cycles are gone');
  r = await http('POST', '/api/cycles', { token: T(admin), body: { batch: dev._id, startDate: '2027-05-01', endDate: '2027-05-10' } });
  ok('POST /api/cycles no longer creates', r.status === 404);
  r = await http('POST', '/api/cycles/bulk', { token: T(admin), body: { batches: [dev._id], startDate: '2027-05-01', endDate: '2027-05-10' } });
  ok('POST /api/cycles/bulk no longer creates', r.status === 404);
  r = await http('PATCH', `/api/cycles/${c5._id}`, { token: T(admin), body: { startDate: '2027-02-20' } });
  ok('editing dates into another cycle is refused', r.status === 400 && /overlap/.test(r.body.message));

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
