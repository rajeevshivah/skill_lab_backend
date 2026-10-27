// Duplicate students (merge without losing history, case-safe roll checks) and
// Top students (score, labels, per-trainer scope, college weights).
// Real Express routes against a throwaway MongoDB.   npm run test:roster
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const M = (n) => require('../models/' + n);
const perf = require('../services/performance');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; fails.push(n); console.log('  FAIL', n, typeof x === 'string' ? x : JSON.stringify(x).slice(0, 300)); } };
let base;
const http = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const today = perf.istYmd(new Date());
const shift = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const day = (n) => perf.ymdToDay(shift(n));

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const college = await require('./college').setup();
  for (const n of ['Student', 'CycleMark', 'ClassPulse', 'ProjectSubmission', 'DailyLog']) await M(n).init();
  const app = express(); app.use(express.json()); app.use(require('../middleware/org').resolveOrg);
  for (const [p, r] of [['students', 'students'], ['settings', 'settings'], ['student', 'student']]) app.use('/api/' + p, require('../routes/' + r));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);

  const admin = await M('User').create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const rohit = await M('User').create({ name: 'Rohit', email: 'r@x.com', password: 'longpassword1', role: 'trainer' });
  const lucky = await M('User').create({ name: 'Lucky', email: 'l@x.com', password: 'longpassword1', role: 'trainer' });
  const sem = await M('Semester').create({ name: 'Odd', status: 'active' });
  const DA = await M('Batch').create({ name: 'Data Analyst', track: 'Data Analysis', semester: sem._id, trainers: [rohit._id], joinCode: 'DACODE' });
  const FS = await M('Batch').create({ name: 'Full Stack', track: 'MERN', semester: sem._id, trainers: [lucky._id] });
  const add = (b, name, roll, extra = {}) => M('Student').create({ name, roll, batch: b._id, semester: sem._id, ...extra });

  // a double import: same roll twice in Data Analyst (one misspelt), plus a clean pair with the same name
  const keep = await add(DA, 'Saumya Jha', '12425407026');
  const dupe = await add(DA, 'Soumya Jha', '12425407026', { flagged: true, github: 'https://github.com/soumya' });
  const k2 = await add(DA, 'Karan Sonkar', '12425407090');
  const d2 = await add(DA, 'Karan Sonkar', '12425407090');
  const ok1 = await add(DA, 'Aditi', '12425407001');
  const fsStu = await add(FS, 'Aditi FS', '12425407001');      // same roll in another batch = track overlap
  const fsTop = await add(FS, 'Meera', 'FS1');

  // history on both records of the first pair
  const c1 = await M('Cycle').create({ batch: DA._id, semester: sem._id, number: 1, startDate: day(-20), endDate: day(-6), track: { projectDate: day(-7) } });
  const c2 = await M('Cycle').create({ batch: DA._id, semester: sem._id, number: 2, startDate: day(-5), endDate: day(8), track: { projectDate: day(6) } });
  await M('CycleMark').create({ cycle: c1._id, batch: DA._id, semester: sem._id, student: keep._id, status: 'not-evaluated' });
  await M('CycleMark').create({ cycle: c1._id, batch: DA._id, semester: sem._id, student: dupe._id, status: 'evaluated', assessment: 80, project: 90 });
  await M('CycleMark').create({ cycle: c1._id, batch: DA._id, semester: sem._id, student: ok1._id, status: 'evaluated', assessment: 50, project: 50 });
  await M('DailyLog').create({ batch: DA._id, semester: sem._id, date: day(-10), status: 'done', attendanceTaken: true,
    attendance: [{ student: keep._id, present: false }, { student: dupe._id, present: true }, { student: ok1._id, present: true }] });
  await M('DailyLog').create({ batch: DA._id, semester: sem._id, date: day(-9), status: 'done', attendanceTaken: true,
    attendance: [{ student: dupe._id, present: true }, { student: ok1._id, present: false }] });
  await M('ClassPulse').create({ batch: DA._id, student: dupe._id, date: shift(-10), covered: 'yes', understanding: 4 });
  await M('ProjectSubmission').create({ cycle: c1._id, batch: DA._id, student: dupe._id, githubUrl: 'https://github.com/x/y', submittedAt: day(-7) });
  await M('Cycle').updateOne({ _id: c1._id }, { $set: { 'report.top3': [{ rank: 1, student: dupe._id, name: 'Soumya Jha' }] } });
  await require('../services/attendanceStats').recomputeBatchStats(DA._id);

  console.log('\n— Duplicates report');
  let r = await http('GET', `/api/students/duplicates?semester=${sem._id}`, { token: T(admin) });
  const g = (roll) => r.body.groups.find(x => x.roll === roll);
  ok('finds both same-batch pairs and the cross-batch roll', r.body.count === 3 && g('12425407026').sameBatch && !g('12425407001').sameBatch, r.body);
  ok('shows marks / attendance per record', g('12425407026').entries.find(e => e.name === 'Soumya Jha').marks === 1);
  ok('a trainer cannot see the report', (await http('GET', `/api/students/duplicates?semester=${sem._id}`, { token: T(rohit) })).status === 403);

  console.log('\n— Merge');
  ok('a trainer of another batch cannot merge', (await http('POST', `/api/students/${dupe._id}/merge`, { token: T(lucky), body: { into: keep._id } })).status === 403);
  ok('records in two batches cannot be merged', (await http('POST', `/api/students/${fsStu._id}/merge`, { token: T(admin), body: { into: ok1._id } })).status === 400);
  r = await http('POST', `/api/students/${dupe._id}/merge`, { token: T(admin), body: { into: keep._id, preview: true } });
  ok('preview counts what moves, changes nothing', r.status === 200 && r.body.moves.marks === 1 && r.body.moves.attendanceDays === 2 && r.body.moves.top3 === 1 && await M('Student').exists({ _id: dupe._id }), r.body);
  r = await http('POST', `/api/students/${dupe._id}/merge`, { token: T(admin), body: { into: keep._id } });
  ok('merge succeeds', r.status === 200, r.body);
  ok('duplicate record is gone', !(await M('Student').exists({ _id: dupe._id })));
  const marks = await M('CycleMark').find({ student: keep._id });
  ok('evaluated mark replaced the not-evaluated one', marks.length === 1 && marks[0].status === 'evaluated' && marks[0].assessment === 80);
  ok('no marks left pointing at the removed record', !(await M('CycleMark').exists({ student: dupe._id })));
  const kept = await M('Student').findById(keep._id);
  ok('attendance: present wins, no double entries', kept.stats.presentCount === 2 && kept.stats.totalSessions === 2, kept.stats);
  const log1 = await M('DailyLog').findOne({ date: day(-10) });
  ok('one attendance entry per student per day', log1.attendance.filter(a => String(a.student) === String(keep._id)).length === 1 && !log1.attendance.some(a => String(a.student) === String(dupe._id)));
  ok('check-in and project submission moved', await M('ClassPulse').exists({ student: keep._id }) && await M('ProjectSubmission').exists({ student: keep._id }));
  const c1n = await M('Cycle').findById(c1._id);
  ok('Hall of Fame Top 3 now points at the kept record (kept name)', String(c1n.report.top3[0].student) === String(keep._id) && c1n.report.top3[0].name === 'Saumya Jha');
  ok('kept record took the flag and GitHub it lacked', kept.flagged && kept.github === 'https://github.com/soumya' && kept.name === 'Saumya Jha');
  ok('stats recounted (top 3, projects)', kept.stats.topperCount === 1 && kept.stats.projectCount === 1, kept.stats);
  r = await http('POST', `/api/students/${d2._id}/merge`, { token: T(admin), body: { into: k2._id } });
  r = await http('GET', `/api/students/duplicates?semester=${sem._id}`, { token: T(admin) });
  ok('after merging, only the cross-batch roll is left', r.body.count === 1 && !r.body.groups[0].sameBatch, r.body);

  console.log('\n— Stopping new duplicates');
  r = await http('POST', '/api/students', { token: T(rohit), body: { batch: DA._id, name: 'Aditi T', roll: '12425407001 ' } });
  ok('adding a roll already in the batch is refused', r.status === 400, r.body);
  const lower = await add(DA, 'Case Test', 'bca7');
  r = await http('POST', '/api/students', { token: T(rohit), body: { batch: DA._id, name: 'Case Two', roll: 'BCA7' } });
  ok('…whatever the letter case', r.status === 400, r.body);
  r = await http('PUT', `/api/students/${lower._id}`, { token: T(rohit), body: { roll: '12425407026' } });
  ok('editing a roll into a clash is refused', r.status === 400);
  r = await http('POST', `/api/students/${fsStu._id}/move`, { token: T(admin), body: { batch: DA._id } });
  ok('moving a student into a batch that has their roll is refused', r.status === 400 && /Merge/.test(r.body.message), r.body);

  console.log('\n— Top students');
  await M('CycleMark').create({ cycle: c1._id, batch: DA._id, semester: sem._id, student: k2._id, status: 'evaluated', assessment: 60, project: 70 });
  r = await http('GET', '/api/students/top', { token: T(admin) });
  const S = (name) => r.body.students.find(s => s.name === name);
  const sj = S('Saumya Jha');
  ok('admin sees every batch', r.status === 200 && r.body.batches.length === 2 && S('Meera'), r.body);
  ok('marks % = (80+90)/200', sj.marks === 85, sj);
  ok('attendance and projects from real records', sj.attendance === 100 && sj.projectsSubmitted === 1 && sj.projectsDue === 1, sj);
  ok('score = 60/25/15 weights → 91, label Excellent', sj.score === 91 && sj.tier === 'excellent', sj);
  ok('ranked first, #1 in batch, Top-3 counted', r.body.students[0].name === 'Saumya Jha' && sj.batchRank === 1 && sj.top3 === 1);
  ok('no evaluated cycle → no label ("too early")', S('Meera').tier === '' && S('Meera').cyclesEvaluated === 0);
  ok('missing parts are left out, not zero', S('Meera').marks === null && S('Meera').score === null);
  const aditi = S('Aditi');   // 50% marks, 50% attendance, 0/1 projects → (50*60+50*25+0*15)/100 = 42.5
  ok('a weak student gets no label', aditi.score === 43 && aditi.tier === '', aditi);
  r = await http('GET', '/api/students/top', { token: T(rohit) });
  ok('trainer sees only own batches', r.body.batches.length === 1 && r.body.students.every(s => s.batch.name === 'Data Analyst'), r.body.batches);
  r = await http('GET', `/api/students/top?batch=${FS._id}`, { token: T(rohit) });
  ok('…even when asking for another batch', r.body.students.length === 0);

  console.log('\n— Admin changes the rules');
  ok('trainer cannot change them', (await http('PUT', '/api/settings/student-score', { token: T(rohit), body: { marks: 100, attendance: 0, projects: 0, good: 50, excellent: 90 } })).status === 403);
  ok('"good" above "excellent" refused', (await http('PUT', '/api/settings/student-score', { token: T(admin), body: { marks: 60, attendance: 25, projects: 15, good: 95, excellent: 80 } })).status === 400);
  r = await http('PUT', '/api/settings/student-score', { token: T(admin), body: { marks: 100, attendance: 0, projects: 0, good: 50, excellent: 90 } });
  ok('admin saves marks-only rules', r.status === 200);
  r = await http('GET', '/api/students/top', { token: T(admin) });
  ok('scores follow the new rules', S('Saumya Jha').score === 85 && S('Saumya Jha').tier === 'good' && S('Aditi').score === 50 && S('Aditi').tier === 'good', r.body.students.slice(0, 4));

  console.log('\n— Trainers fix their own roster');
  const cot = await M('User').create({ name: 'Cot', email: 'c@x.com', password: 'longpassword1', role: 'cotrainer' });
  await M('Batch').updateOne({ _id: DA._id }, { $addToSet: { trainers: cot._id } });
  const tw1 = await add(DA, 'Vikas Kumar', '12425407145'), tw2 = await add(DA, 'Vikas Kumar', '12425407145');
  // a saved marks sheet leaves an empty "not evaluated" row for everyone
  await M('CycleMark').create({ cycle: c2._id, batch: DA._id, semester: sem._id, student: tw2._id, status: 'not-evaluated' });
  await M('DailyLog').create({ batch: DA._id, semester: sem._id, date: day(-3), status: 'done', attendanceTaken: true,
    attendance: [{ student: tw1._id, present: true }, { student: tw2._id, present: true }] });
  r = await http('POST', '/api/student/activate', { body: { roll: '12425407145', code: 'DACODE', password: 'secret12' } });
  ok('sign-up with a doubled roll says to merge', r.status === 409 && /Merge/.test(r.body.message), r.body);
  ok('a co-trainer cannot merge', (await http('POST', `/api/students/${tw2._id}/merge`, { token: T(cot), body: { into: tw1._id } })).status === 403);
  ok('another batch\'s trainer cannot merge', (await http('POST', `/api/students/${tw2._id}/merge`, { token: T(lucky), body: { into: tw1._id } })).status === 403);
  r = await http('POST', `/api/students/${tw2._id}/merge`, { token: T(rohit), body: { into: tw1._id } });
  ok('the batch trainer merges the pair', r.status === 200 && !(await M('Student').exists({ _id: tw2._id })), r.body);
  r = await http('POST', '/api/student/activate', { body: { roll: '12425407145', code: 'DACODE', password: 'secret12' } });
  ok('…then the student can set up', r.status === 201, r.body);
  const gone = await add(DA, 'Wrong Entry', 'X999');
  await M('CycleMark').create({ cycle: c2._id, batch: DA._id, semester: sem._id, student: gone._id, status: 'not-evaluated' });
  await M('DailyLog').updateOne({ date: day(-3), batch: DA._id }, { $push: { attendance: { student: gone._id, present: true } } });
  r = await http('DELETE', `/api/students/${gone._id}`, { token: T(rohit) });
  ok('trainer removes a student who only has an empty mark row', r.status === 200, r.body);
  ok('…their empty mark row and attendance tick go too', !(await M('CycleMark').exists({ student: gone._id })) && !(await M('DailyLog').findOne({ date: day(-3), batch: DA._id })).attendance.some(a => String(a.student) === String(gone._id)));
  r = await http('DELETE', `/api/students/${keep._id}`, { token: T(rohit) });
  ok('a student with real marks is still protected', r.status === 409);

  console.log('\n— Lateral entry: temporary ID');
  r = await http('POST', '/api/students', { token: T(rohit), body: { batch: DA._id, name: 'Lateral Lata', course: 'B.Tech', sem: '3' } });
  const tmp = r.body.student;
  ok('no roll → a temporary ID TMP-XXXXX', r.status === 201 && /^TMP-[A-Z2-9]{5}$/.test(tmp.roll) && tmp.rollTemporary === true, r.body);
  r = await http('POST', '/api/student/activate', { body: { roll: tmp.roll.toLowerCase(), code: 'DACODE', password: 'latapass1' } });
  ok('the student signs up with the temporary ID', r.status === 201, r.body);
  r = await http('PUT', `/api/students/${tmp._id}`, { token: T(rohit), body: { roll: '2503840100099' } });
  ok('trainer types the real roll over it', r.status === 200 && r.body.student.roll === '2503840100099' && r.body.student.rollTemporary === false, r.body);
  r = await http('POST', '/api/student/login', { body: { roll: '2503840100099', password: 'latapass1' } });
  ok('the same password works with the real roll', r.status === 200, r.body);
  r = await http('POST', '/api/students/bulk', { token: T(rohit), body: { batch: DA._id, rows: [{ name: 'Late One' }, { name: 'Late Two' }, { roll: 'R1', name: 'With Roll' }] } });
  ok('import: rows without a roll get their own temporary IDs', r.status === 201 && r.body.temporaryIds.length === 2 && r.body.temporaryIds[0].roll !== r.body.temporaryIds[1].roll, r.body);
  r = await http('GET', `/api/students?batch=${DA._id}`, { token: T(rohit) });
  ok('roster marks them temporary', r.body.students.filter(s => s.rollTemporary).length === 2);

  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed:', fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
