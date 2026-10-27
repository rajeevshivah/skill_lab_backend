// Plan store: one-row edits, conflict protection, lock rule, plan credit.
//   npm run test:plans
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const User = require('../models/User'), Semester = require('../models/Semester'), Batch = require('../models/Batch');
const Cycle = require('../models/Cycle'), CyclePlan = require('../models/CyclePlan');
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
  app.use('/api/cycleplans', require('../routes/cycleplans'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = await User.create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const lucky = await User.create({ name: 'Lucky', email: 'l@x.com', password: 'longpassword1', role: 'trainer' });
  const deepu = await User.create({ name: 'Deepu', email: 'd@x.com', password: 'longpassword1', role: 'trainer' });
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const sem = await Semester.create({ name: 'S', status: 'active' });
  const b = await Batch.create({ name: 'B', semester: sem._id, trainers: [lucky._id, deepu._id] });
  const c = await Cycle.create({ batch: b._id, semester: sem._id, number: 1, startDate: perf.ymdToDay('2027-03-01'), endDate: perf.ymdToDay('2027-03-12'), track: { tracked: true } });
  // As the cycle planner does: dated rows with no topics yet (project row titled)
  await CyclePlan.create({ cycle: c._id, batch: b._id, semester: sem._id, classes: [
    { number: 10, title: '', date: '2027-03-01' }, { number: 11, title: '', date: '2027-03-02' }, { number: 12, title: 'Cycle 1 project day', date: '2027-03-03' }] });

  console.log('\n— incomplete plan: trainers fill it row by row');
  let r = await http('GET', `/api/cycleplans/${c._id}`, { token: T(lucky) });
  ok('trainer can edit an incomplete plan', r.body.canEdit === true && r.body.complete === false, JSON.stringify(r.body).slice(0, 200));
  r = await http('PATCH', `/api/cycleplans/${c._id}/class/10`, { token: T(lucky), body: { title: 'Big O', baseUpdatedAt: '' } });
  ok('one-row edit saves', r.status === 200 && r.body.classes.find(k => k.number === 10).title === 'Big O', JSON.stringify(r.body));
  const row10 = r.body.classes.find(k => k.number === 10);
  ok('row records who changed it', String(row10.updatedBy) === String(lucky._id) && row10.updatedAt);
  ok('not complete yet → no plan credit', !(await Cycle.findById(c._id)).track.plan?.at);
  r = await http('PATCH', `/api/cycleplans/${c._id}/class/10`, { token: T(deepu), body: { title: 'Searching', baseUpdatedAt: '' } });
  ok('stale row edit → 409, not overwritten', r.status === 409 && r.body.current?.title === 'Big O', JSON.stringify(r.body));
  r = await http('PATCH', `/api/cycleplans/${c._id}/class/10`, { token: T(deepu), body: { notes: 'with examples', baseUpdatedAt: new Date(row10.updatedAt).toISOString() } });
  ok('edit with the current row version works', r.status === 200 && r.body.classes.find(k => k.number === 10).notes === 'with examples');
  r = await http('PATCH', `/api/cycleplans/${c._id}/class/11`, { token: T(deepu), body: { title: 'Sorting' } });
  ok('another row by another trainer is independent', r.status === 200);
  ok('completing the plan stamps credit to the completer', r.body.complete === true && String((await Cycle.findById(c._id)).track.plan.by) === String(deepu._id));

  console.log('\n— complete plan is locked');
  r = await http('PATCH', `/api/cycleplans/${c._id}/class/11`, { token: T(lucky), body: { title: 'x' } });
  ok('trainer cannot edit a complete plan', r.status === 403 && /locked/.test(r.body.message));
  r = await http('POST', `/api/cycleplans/${c._id}/class`, { token: T(admin), body: { number: 13, title: 'Extra', date: '2027-03-08' } });
  ok('admin adds a class', r.status === 200 && r.body.classes.length === 4);
  r = await http('POST', `/api/cycleplans/${c._id}/class`, { token: T(admin), body: { number: 13, title: 'Dup' } });
  ok('adding an existing number refused', r.status === 409);
  r = await http('DELETE', `/api/cycleplans/${c._id}/class/13`, { token: T(admin) });
  ok('admin removes a class', r.status === 200 && r.body.classes.length === 3);

  console.log('\n— whole-list save conflict');
  const g = await http('GET', `/api/cycleplans/${c._id}`, { token: T(admin) });
  const v = g.body.version;
  r = await http('PUT', `/api/cycleplans/${c._id}`, { token: T(admin), body: { version: v, classes: g.body.classes.map(k => ({ ...k, trainer: null })) } });
  ok('save with current version works', r.status === 200 && r.body.version > v, JSON.stringify(r.body).slice(0, 200));
  r = await http('PUT', `/api/cycleplans/${c._id}`, { token: T(admin), body: { version: v, classes: [] } });
  ok('save from an old version → 409 (nothing wiped)', r.status === 409 && (await CyclePlan.findOne({ cycle: c._id })).classes.length === 3);
  r = await http('PUT', `/api/cycleplans/${c._id}`, { token: T(admin), body: { classes: [{ number: 1, title: 'a' }, { number: 1, title: 'b' }] } });
  ok('duplicate numbers refused', r.status === 400);
  const hist = (await CyclePlan.findOne({ cycle: c._id }).lean()).changes;
  ok('history kept for every change', hist.length === 5 && hist.some(h => /class 10: topic/.test(h.text)), JSON.stringify(hist.map(h => h.text)));

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
