// Meeting screens: daily review, cycle review, notes.   npm run test:meeting
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const User = require('../models/User'), Semester = require('../models/Semester'), Batch = require('../models/Batch');
const Cycle = require('../models/Cycle'), CyclePlan = require('../models/CyclePlan'), DailyLog = require('../models/DailyLog');
const Student = require('../models/Student'), CycleMark = require('../models/CycleMark'), ClassPulse = require('../models/ClassPulse');
const Holiday = require('../models/Holiday');
const perf = require('../services/performance');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x); } };
let base;
const http = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const today = perf.istYmd(new Date());
const sh = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D = perf.ymdToDay;

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const app = express(); app.use(express.json());
  app.use('/api/meeting', require('../routes/meeting'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = await User.create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const lucky = await User.create({ name: 'Lucky', email: 'l@x.com', password: 'longpassword1', role: 'trainer' });
  const deepu = await User.create({ name: 'Deepu', email: 'd@x.com', password: 'longpassword1', role: 'trainer' });
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const sem = await Semester.create({ name: 'S', status: 'active' });
  const A = await Batch.create({ name: 'A Batch', semester: sem._id, trainers: [lucky._id] });
  const B = await Batch.create({ name: 'B Batch', semester: sem._id, trainers: [deepu._id] });
  const C = await Batch.create({ name: 'C Batch', semester: sem._id, trainers: [deepu._id] });
  const ca = await Cycle.create({ batch: A._id, semester: sem._id, number: 2, startDate: D(sh(-6)), endDate: D(sh(-1)), track: { tracked: true, trackedFrom: D(sh(-7)), deadline: perf.istToDate(`${sh(1)}T19:00`) } });
  const cb = await Cycle.create({ batch: B._id, semester: sem._id, number: 5, startDate: D(sh(-6)), endDate: D(sh(-1)), track: { tracked: true, trackedFrom: D(sh(-7)), deadline: perf.istToDate(`${sh(1)}T19:00`) } });
  const cc = await Cycle.create({ batch: C._id, semester: sem._id, number: 1, startDate: D(sh(-6)), endDate: D(sh(-1)) });
  const day = sh(-2);
  await CyclePlan.create({ cycle: ca._id, batch: A._id, semester: sem._id, classes: [{ number: 10, title: 'Big O', date: sh(-3) }, { number: 11, title: 'Searching', notes: 'linear + binary', date: day }] });
  await CyclePlan.create({ cycle: cb._id, batch: B._id, semester: sem._id, classes: [{ number: 30, title: 'Hooks', date: day }] });
  await CyclePlan.create({ cycle: cc._id, batch: C._id, semester: sem._id, classes: [{ number: 1, title: 'Intro', date: day }] });
  const S = [];
  for (let i = 0; i < 6; i++) S.push(await Student.create({ name: 'S' + i, roll: String(i), batch: A._id, semester: sem._id }));
  await DailyLog.create({ batch: A._id, semester: sem._id, date: D(day), status: 'done', planClass: 11, github: 'most', notes: 'Covered linear search',
    attendance: S.map((s, i) => ({ student: s._id, present: i < 5 })), attendanceTaken: true, loggedBy: lucky._id, firstLoggedBy: lucky._id, createdAt: new Date() });
  for (let i = 0; i < 6; i++) await ClassPulse.create({ batch: A._id, student: S[i]._id, date: day, covered: i < 5 ? 'no' : 'yes', understanding: 3 });
  await Holiday.create({ semester: sem._id, from: day, to: day, title: 'Fest', batches: [C._id] });
  for (const [i, cat] of ['excellent', 'moderate', 'basic'].entries())
    await CycleMark.create({ cycle: ca._id, batch: A._id, semester: sem._id, student: S[i]._id, status: 'evaluated', project: 80 - i * 25, category: cat });

  console.log('\n— daily review');
  let r = await http('GET', `/api/meeting/day?date=${day}`, { token: T(admin) });
  const a = r.body.batches?.find(x => x.batch === 'A Batch'), b = r.body.batches?.find(x => x.batch === 'B Batch'), c = r.body.batches?.find(x => x.batch === 'C Batch');
  ok('every batch with a class that day', r.status === 200 && r.body.batches.length === 3, JSON.stringify(r.body).slice(0, 300));
  ok('A: plan vs log', a.planned[0].title === 'Searching' && a.log.planClassTitle === 'Searching' && a.log.notes === 'Covered linear search' && a.log.by === 'Lucky');
  ok('A: attendance 5/6, GitHub most', a.log.attendance.present === 5 && a.log.attendance.total === 6 && a.log.github === 'most');
  ok('A: students disagree → mismatch', a.pulse.responses === 6 && a.pulse.mismatch === true, JSON.stringify(a.pulse));
  ok('B: planned but not logged', b.planned.length === 1 && b.log === null);
  ok('C: holiday shown', c.holiday === 'Fest');
  r = await http('GET', `/api/meeting/day?date=${day}`, { token: T(deepu) });
  ok('trainers can open it too (marked mine)', r.body.batches.find(x => x.batch === 'B Batch').mine === true && r.body.batches.find(x => x.batch === 'A Batch').mine === false);

  console.log('\n— notes');
  r = await http('POST', '/api/meeting/notes', { token: T(admin), body: { scope: 'day', date: day, batchId: String(B._id), text: 'Deepu: log Hooks class today' } });
  ok('admin adds a day note', r.status === 201 && r.body.note.batch.name === 'B Batch');
  const nB = r.body.note._id;
  await http('POST', '/api/meeting/notes', { token: T(admin), body: { scope: 'day', date: day, batchId: String(A._id), text: 'A: revise binary search' } });
  r = await http('POST', '/api/meeting/notes', { token: T(lucky), body: { scope: 'day', date: day, batchId: String(B._id), text: 'x' } });
  ok('trainer cannot add notes on another batch', r.status === 403);
  r = await http('POST', '/api/meeting/notes', { token: T(lucky), body: { scope: 'cycle', period: sh(1), trainerId: String(deepu._id), text: 'x' } });
  ok('trainer cannot write notes about another trainer', r.status === 403);
  r = await http('GET', `/api/meeting/day?date=${sh(-1)}`, { token: T(deepu) });
  ok('open notes carry over to the next day', r.body.notes.some(n => n._id === nB), JSON.stringify(r.body.notes));
  ok('trainer sees only notes for their batches', !r.body.notes.some(n => n.batch?.name === 'A Batch'));
  r = await http('PATCH', `/api/meeting/notes/${nB}`, { token: T(deepu), body: { status: 'done' } });
  ok('the trainer concerned marks it done', r.status === 200 && r.body.note.status === 'done' && r.body.note.doneBy === 'Deepu');
  r = await http('PATCH', `/api/meeting/notes/${nB}`, { token: T(deepu), body: { text: 'changed' } });
  ok('only author/admin edits the text', r.status === 403);
  r = await http('GET', `/api/meeting/day?date=${sh(-1)}`, { token: T(admin) });
  ok('done notes stop carrying over', !r.body.notes.some(n => n._id === nB));
  ok('trainer cannot delete admin note', (await http('DELETE', `/api/meeting/notes/${nB}`, { token: T(deepu) })).status === 403);

  console.log('\n— cycle review');
  const period = perf.istYmd(perf.deadlineOf(ca));
  await http('POST', '/api/meeting/notes', { token: T(admin), body: { scope: 'cycle', period, trainerId: String(lucky._id), text: 'Lucky: good pace, push GitHub habit' } });
  r = await http('GET', `/api/meeting/review?period=${period}`, { token: T(admin) });
  const L = r.body.trainers?.find(t => t.name === 'Lucky');
  ok('review lists trainers of the period', r.status === 200 && L && r.body.trainers.some(t => t.name === 'Deepu'), JSON.stringify(r.body).slice(0, 300));
  const la = L.batches[0];
  ok('plan delivery: 2 due, 1 not logged, 1 done', la.plan.due === 2 && la.plan.notLogged === 1 && la.plan.done === 1, JSON.stringify(la.plan));
  ok('marks spread', la.marks.excellent === 1 && la.marks.moderate === 1 && la.marks.basic === 1 && la.marks.students === 6);
  ok('student understanding average', la.pulse.understanding === 3 && la.pulse.days === 1);
  ok('score present', typeof la.score === 'number');
  ok('note shown on the trainer card', L.notes.length === 1 && /GitHub habit/.test(L.notes[0].text));
  r = await http('GET', `/api/meeting/review?period=${period}`, { token: T(lucky) });
  ok('trainer sees the note about himself', r.body.trainers.find(t => t.name === 'Lucky').notes.length === 1);
  ok('…but not notes about others', r.body.trainers.find(t => t.name === 'Deepu').notes.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
