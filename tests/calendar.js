// Batch timetables + holidays (preview, shift, conflict, mark-only, undo, scoring).
//   npm run test:calendar
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const User = require('../models/User'), Semester = require('../models/Semester'), Batch = require('../models/Batch');
const Cycle = require('../models/Cycle'), CyclePlan = require('../models/CyclePlan'), DailyLog = require('../models/DailyLog');
const Student = require('../models/Student');
const perf = require('../services/performance');
const sv = require('../services/studentView');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x); } };
let base;
const http = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const D = perf.ymdToDay;
const planOf = async (cid) => Object.fromEntries((await CyclePlan.findOne({ cycle: cid }).lean()).classes.map(k => [k.number, k.date]));

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const college = await require('./college').setup();
  const app = express(); app.use(express.json());
  app.use('/api/settings', require('../routes/settings'));
  app.use('/api/cycleplans', require('../routes/cycleplans'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = await User.create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const lucky = await User.create({ name: 'Lucky', email: 'l@x.com', password: 'longpassword1', role: 'trainer' });
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const sem = await Semester.create({ name: 'Even 2027', status: 'active' });
  const dev = await Batch.create({ name: 'Dev Core', semester: sem._id, trainers: [lucky._id] });
  const fs  = await Batch.create({ name: 'Full Stack', semester: sem._id, trainers: [lucky._id] });
  const empty = await Batch.create({ name: 'Empty', semester: sem._id, trainers: [] });
  // Dev Core Mon–Wed; Cycle A 1–17 Mar 2027 (Mon 1 Mar), Cycle B from 22 Mar
  const A = await Cycle.create({ batch: dev._id, semester: sem._id, number: 4, startDate: D('2027-03-01'), endDate: D('2027-03-17'),
    track: { tracked: true, projectDate: D('2027-03-10'), deadline: perf.istToDate('2027-03-13T19:00') } });
  const Bc = await Cycle.create({ batch: dev._id, semester: sem._id, number: 5, startDate: D('2027-03-22'), endDate: D('2027-04-09') });
  const cls = [[41, '2027-03-01'], [42, '2027-03-02'], [43, '2027-03-03'], [44, '2027-03-08'], [45, '2027-03-09'], [46, '2027-03-10']];
  await CyclePlan.create({ cycle: A._id, batch: dev._id, semester: sem._id, classes: cls.map(([n, d]) => ({ number: n, title: 'C' + n, date: d })) });
  await CyclePlan.create({ cycle: Bc._id, batch: dev._id, semester: sem._id, classes: [{ number: 47, title: 'C47', date: '2027-03-22' }] });
  // Full Stack Mon–Thu
  const F = await Cycle.create({ batch: fs._id, semester: sem._id, number: 4, startDate: D('2027-03-01'), endDate: D('2027-03-12') });
  await CyclePlan.create({ cycle: F._id, batch: fs._id, semester: sem._id, classes: [['2027-03-01', 1], ['2027-03-02', 2], ['2027-03-03', 3], ['2027-03-04', 4], ['2027-03-08', 5], ['2027-03-11', 6]].map(([d, n]) => ({ number: n, title: 'F' + n, date: d })) });

  console.log('\n— timetables');
  let r = await http('GET', '/api/settings/timetables', { token: T(lucky) });
  ok('trainer cannot open settings', r.status === 403);
  r = await http('GET', '/api/settings/timetables', { token: T(admin) });
  const tDev = r.body.batches.find(b => b.name === 'Dev Core'), tFs = r.body.batches.find(b => b.name === 'Full Stack');
  ok('Dev Core guessed Mon–Wed from its plans', tDev.source === 'guessed' && tDev.days.join() === '1,2,3', JSON.stringify(tDev));
  ok('Full Stack guessed Mon–Thu', tFs.days.join() === '1,2,3,4', JSON.stringify(tFs));
  r = await http('PUT', `/api/settings/timetables/${dev._id}`, { token: T(admin), body: { days: [3, 1, 2, 9] } });
  ok('admin saves timetable (bad values dropped)', r.body.days.join() === '1,2,3');
  r = await http('GET', '/api/settings/timetables', { token: T(admin) });
  ok('saved timetable shown as saved', r.body.batches.find(b => b.name === 'Dev Core').source === 'saved');

  console.log('\n— holiday preview + shift');
  const body = { from: '2027-03-02', to: '2027-03-03', title: 'Annual function', batchIds: [String(dev._id)], mode: 'shift' };
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body });
  const pv = r.body.batches?.[0];
  ok('preview lists moves in order', r.status === 200 && pv.moves.map(m => `${m.number}:${m.to}`).join() === '42:2027-03-08,43:2027-03-09,44:2027-03-10,45:2027-03-15,46:2027-03-16', JSON.stringify(pv?.moves));
  ok('class before the holiday does not move', !pv.moves.some(m => m.number === 41));
  ok('preview: project day + deadline move, end stays', pv.cycleChanges[0].projectTo === '2027-03-16' && !pv.cycleChanges[0].endTo
    && new Date(pv.cycleChanges[0].deadlineTo).toISOString() === perf.istToDate('2027-03-20T19:00').toISOString(), JSON.stringify(pv.cycleChanges));
  ok('preview saved nothing', (await planOf(A._id))[42] === '2027-03-02');
  r = await http('POST', '/api/settings/holidays', { token: T(lucky), body });
  ok('trainer cannot mark holidays', r.status === 403);
  r = await http('POST', '/api/settings/holidays', { token: T(admin), body });
  ok('admin marks the holiday', r.status === 201 && r.body.moved === 5, JSON.stringify(r.body));
  const hid = r.body.holidayId;
  let p = await planOf(A._id);
  ok('plan dates moved', p[42] === '2027-03-08' && p[46] === '2027-03-16' && p[41] === '2027-03-01');
  let a = await Cycle.findById(A._id);
  ok('cycle project day + deadline updated', perf.dayYmd(a.track.projectDate) === '2027-03-16' && +a.track.deadline === +perf.istToDate('2027-03-20T19:00'));
  const hist = (await CyclePlan.findOne({ cycle: A._id }).lean()).changes.pop();
  ok('change history says why', /Holiday Annual function/.test(hist.text) && String(hist.by) === String(admin._id), hist.text);
  ok('other batch untouched', (await planOf(F._id))[2] === '2027-03-02');
  r = await http('GET', '/api/cycleplans/board?period=' + perf.istYmd(perf.deadlineOf(a)), { token: T(admin) });
  ok('board lists the holiday', r.body.holidays?.some(h => h.title === 'Annual function'), JSON.stringify(r.body.holidays));

  console.log('\n— a second holiday stacks on top');
  r = await http('POST', '/api/settings/holidays', { token: T(admin), body: { from: '2027-03-15', to: '2027-03-15', title: 'Local holiday', batchIds: [String(dev._id)] } });
  p = await planOf(A._id);
  ok('45 → Tue 16, 46 → Wed 17 (skips both holidays)', p[45] === '2027-03-16' && p[46] === '2027-03-17', JSON.stringify(p));
  const hid2 = r.body.holidayId;

  console.log('\n— conflict with the next cycle');
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { from: '2027-03-16', to: '2027-03-17', title: 'Long', batchIds: [String(dev._id)] } });
  ok('refuses when the cycle would run into the next one', r.body.ok === false && /into Cycle 5/.test(r.body.batches[0].conflict || ''), JSON.stringify(r.body.batches?.[0]));
  r = await http('POST', '/api/settings/holidays', { token: T(admin), body: { from: '2027-03-16', to: '2027-03-17', title: 'Long', batchIds: [String(dev._id)] } });
  ok('apply also refused', r.status === 400);
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { from: '2027-03-16', to: '2027-03-17', title: 'Long', batchIds: [String(dev._id)], mode: 'mark' } });
  ok('"mark only" lists classes to re-plan, moves nothing', r.body.ok && r.body.batches[0].moves.length === 0 && r.body.batches[0].onHoliday.map(x => x.number).join() === '45,46', JSON.stringify(r.body.batches[0]));

  console.log('\n— guessed timetable blocks moving');
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { from: '2027-03-11', to: '2027-03-11', title: 'All' } });
  ok('shift refused while a batch timetable is only guessed', r.body.ok === false && /only guessed/.test(r.body.batches.find(b => b.batch === 'Full Stack').conflict || ''), JSON.stringify(r.body.batches.find(b => b.batch === 'Full Stack')));
  await http('PUT', `/api/settings/timetables/${fs._id}`, { token: T(admin), body: { days: [1, 2, 3, 4] } });

  console.log('\n— all batches + end date extension');
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { from: '2027-03-11', to: '2027-03-11', title: 'All' } });
  const fsRow = r.body.batches.find(b => b.batch === 'Full Stack'), emRow = r.body.batches.find(b => b.batch === 'Empty');
  ok('all batches included', r.body.batches.length === 3);
  ok('Full Stack class 6 → Mon 15 and cycle end extends', fsRow.moves[0].to === '2027-03-15' && fsRow.cycleChanges[0].endTo === '2027-03-15', JSON.stringify(fsRow));
  ok('batch with no classes: nothing to do', emRow.moves.length === 0 && !emRow.conflict);

  console.log('\n— held classes never move');
  await DailyLog.create({ batch: fs._id, semester: sem._id, date: D('2027-03-04'), status: 'done', notes: 'held', loggedBy: lucky._id });
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { from: '2027-03-04', to: '2027-03-04', title: 'X', batchIds: [String(fs._id)] } });
  ok('class with a log on that day stays', !r.body.batches[0].moves.some(m => m.number === 4), JSON.stringify(r.body.batches[0].moves));

  console.log('\n— undo');
  r = await http('DELETE', `/api/settings/holidays/${hid2}`, { token: T(admin) });
  p = await planOf(A._id);
  ok('removing the 2nd holiday moves 45/46 back', r.status === 200 && p[45] === '2027-03-15' && p[46] === '2027-03-16', JSON.stringify(p));
  r = await http('DELETE', `/api/settings/holidays/${hid}`, { token: T(admin) });
  p = await planOf(A._id); a = await Cycle.findById(A._id);
  ok('removing the 1st restores the original plan', cls.every(([n, d]) => p[n] === d), JSON.stringify(p));
  ok('project day + deadline restored', perf.dayYmd(a.track.projectDate) === '2027-03-10' && +a.track.deadline === +perf.istToDate('2027-03-13T19:00'));
  r = await http('GET', '/api/settings/holidays', { token: T(admin) });
  ok('holiday list empty again', r.body.holidays.length === 0);

  console.log('\n— holidays are not class days (score, student question)');
  const today = perf.istYmd(new Date());
  const sh = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const lb = await Batch.create({ name: 'Live', semester: sem._id, trainers: [lucky._id] });
  const L = await Cycle.create({ batch: lb._id, semester: sem._id, number: 1, startDate: D(sh(-6)), endDate: D(sh(6)), track: { tracked: true, trackedFrom: D(sh(-7)) } });
  await CyclePlan.create({ cycle: L._id, batch: lb._id, semester: sem._id, classes: [{ number: 1, title: 'A', date: sh(-3) }, { number: 2, title: 'B', date: today }] });
  let sc = await perf.scoreCycle(L);
  ok('before: the missed day counts as missing', sc.items.logs.missing === 1, JSON.stringify(sc.items.logs));
  ok('before: today has a class for students', !!(await sv.classOn(lb._id, today)));
  await http('POST', '/api/settings/holidays', { token: T(admin), body: { from: sh(-3), to: today, title: 'Fest', batchIds: [String(lb._id)], mode: 'mark' } });
  sc = await perf.scoreCycle(await Cycle.findById(L._id));
  ok('after: holiday days not counted', (sc.items.logs.days || 0) === 0 && !sc.items.logs.missing, JSON.stringify(sc.items.logs));
  ok('after: no class question on a holiday', (await sv.classOn(lb._id, today)) === null);
  const st = await Student.create({ name: 'S', roll: '1', batch: lb._id, semester: sem._id });
  const home = await sv.studentHome(st);
  ok('student page shows the holiday', home.holidayToday === 'Fest' && home.cycle.classes.find(c => c.number === 2).holiday === 'Fest');

  console.log('\n— keep the project day: classes move up to it, the one that no longer fits merges');
  const kb = await Batch.create({ name: 'Keep', semester: sem._id, trainers: [lucky._id], schedule: { days: [1, 3] } });
  const K = await Cycle.create({ batch: kb._id, semester: sem._id, number: 2, startDate: D('2027-03-01'), endDate: D('2027-03-12'),
    track: { tracked: true, projectDate: D('2027-03-10') } });
  const kcls = [[20, '2027-03-01'], [21, '2027-03-03'], [22, '2027-03-08'], [23, '2027-03-10']];
  await CyclePlan.create({ cycle: K._id, batch: kb._id, semester: sem._id, classes: kcls.map(([n, d]) => ({ number: n, title: 'K' + n, notes: 'n' + n, date: d })) });
  const kbody = { from: '2027-03-01', title: 'College closed', batchIds: [String(kb._id)], mode: 'keep' };
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: kbody });
  let kr = r.body.batches[0];
  ok('preview: 20→3 Mar, 21→8 Mar, 22 merges into 21, project row stays', kr.moves.map(m => `${m.number}:${m.to}`).join() === '20:2027-03-03,21:2027-03-08'
    && kr.merges[0].into === 21 && kr.merges[0].removed[0].number === 22 && !kr.cycleChanges.length, JSON.stringify(kr));
  r = await http('POST', '/api/settings/holidays', { token: T(admin), body: kbody });
  ok('applied', r.status === 201 && r.body.merged === 1, JSON.stringify(r.body));
  const khid = r.body.holidayId;
  let kp = (await CyclePlan.findOne({ cycle: K._id }).lean()).classes;
  const kn = (n) => kp.find(k => k.number === n);
  ok('class 21 now holds both topics on 8 Mar', kn(21).date === '2027-03-08' && kn(21).title === 'K21 + K22' && /Merged from class 22/.test(kn(21).notes) && /n22/.test(kn(21).notes), JSON.stringify(kn(21)));
  ok('class 22 row is gone, project class 23 unchanged on 10 Mar', !kn(22) && kn(23).date === '2027-03-10');
  ok('project day and cycle end unchanged', perf.dayYmd((await Cycle.findById(K._id)).track.projectDate) === '2027-03-10' && perf.dayYmd((await Cycle.findById(K._id)).endDate) === '2027-03-12');
  r = await http('DELETE', `/api/settings/holidays/${khid}`, { token: T(admin) });
  kp = (await CyclePlan.findOne({ cycle: K._id }).lean()).classes;
  ok('undo splits the merge and restores every date', r.status === 200 && kcls.every(([n, d]) => kn(n)?.date === d && kn(n).title === 'K' + n && kn(n).notes === 'n' + n), JSON.stringify(kp));
  // no room left at all → refused
  await CyclePlan.updateOne({ cycle: K._id }, { $set: { classes: [{ number: 20, title: 'K20', date: '2027-03-08' }, { number: 23, title: 'K23', date: '2027-03-10' }] } });
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { ...kbody, from: '2027-03-08' } });
  ok('refused when no class day is left before the project day', r.body.ok === false && /No class day is left/.test(r.body.batches[0].conflict || ''), JSON.stringify(r.body.batches[0]));
  await CyclePlan.updateOne({ cycle: K._id }, { $set: { classes: kcls.map(([n, d]) => ({ number: n, title: 'K' + n, notes: 'n' + n, date: d })) } });

  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { ...kbody, from: '2027-03-10' } });
  ok('keep: refused when the project day itself is the holiday', r.body.ok === false && /project day of Cycle 2/.test(r.body.batches[0].conflict || ''), JSON.stringify(r.body.batches[0]));
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { ...kbody, from: '2027-03-01', to: '2027-03-03' } });
  ok('keep: warns when several topics would be squeezed into one class', r.body.ok && /topics would be squeezed/.test(r.body.batches[0].note || ''), JSON.stringify(r.body.batches[0]));

  console.log('\n— make-up day: Monday classes held on Saturday');
  const mbody = { from: '2027-03-01', title: 'College closed', batchIds: [String(kb._id)], mode: 'makeup', makeupDate: '2027-03-06' };
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { ...mbody, makeupDate: '2027-03-03' } });
  ok('refused when the batch already has a class that day', r.body.ok === false && /already has class 21/.test(r.body.batches[0].conflict || ''), JSON.stringify(r.body.batches[0]));
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { ...mbody, makeupDate: '2027-03-20' } });
  ok('refused outside the cycle', r.body.ok === false && /outside Cycle 2/.test(r.body.batches[0].conflict || ''));
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { ...mbody, to: '2027-03-02' } });
  ok('refused for more than one day', r.status === 400);
  r = await http('POST', '/api/settings/holidays', { token: T(admin), body: mbody });
  ok('applied: only that day moves', r.status === 201 && r.body.moved === 1, JSON.stringify(r.body));
  const mhid = r.body.holidayId;
  kp = (await CyclePlan.findOne({ cycle: K._id }).lean()).classes;
  ok('class 20 on Saturday 6 Mar, others unchanged', kn(20).date === '2027-03-06' && kn(21).date === '2027-03-03' && kn(22).date === '2027-03-08');
  ok('students get the class question on the Saturday', (await sv.classOn(kb._id, '2027-03-06'))?.number === 20);
  ok('Monday is a holiday', (await sv.classOn(kb._id, '2027-03-01')) === null && (await sv.holidayOn(kb._id, '2027-03-01')) === 'College closed');
  r = await http('GET', '/api/settings/holidays', { token: T(admin) });
  ok('holiday list shows the make-up date', r.body.holidays.some(h => h.mode === 'makeup' && h.makeupDate === '2027-03-06'));
  r = await http('DELETE', `/api/settings/holidays/${mhid}`, { token: T(admin) });
  kp = (await CyclePlan.findOne({ cycle: K._id }).lean()).classes;
  ok('undo moves it back to Monday', kn(20).date === '2027-03-01');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
