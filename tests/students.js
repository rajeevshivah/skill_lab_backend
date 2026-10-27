// Student sign-in, My cycle, project submission, class pulse, trainer feedback.
// Real Express routes against a throwaway MongoDB.   npm run test:students
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const User = require('../models/User'), Semester = require('../models/Semester'), Batch = require('../models/Batch');
const Student = require('../models/Student'), Cycle = require('../models/Cycle'), CyclePlan = require('../models/CyclePlan');
const CycleMark = require('../models/CycleMark'), DailyLog = require('../models/DailyLog');
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
const shift = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const day = (n) => perf.ymdToDay(shift(today, n));

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const college = await require('./college').setup();
  const app = express(); app.use(express.json({ limit: '5mb' }));
  for (const [p, r] of [['students', 'students'], ['cycleplans', 'cycleplans'], ['student', 'student'], ['student-admin', 'studentAdmin'], ['feedback', 'feedback']])
    app.use('/api/' + p, require('../routes/' + r));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = await User.create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const lucky = await User.create({ name: 'Lucky', email: 'l@x.com', password: 'longpassword1', role: 'trainer' });
  const deepu = await User.create({ name: 'Deepu', email: 'd@x.com', password: 'longpassword1', role: 'trainer' });
  const md    = await User.create({ name: 'MD (Review)', email: 'm@x.com', password: 'longpassword1', role: 'trainer' });
  const sem = await Semester.create({ name: 'Odd', status: 'active' });
  const b = await Batch.create({ name: 'BCA 3 A', semester: sem._id, trainers: [lucky._id, md._id] });
  const other = await Batch.create({ name: 'BTech 3', semester: sem._id, trainers: [deepu._id] });
  const S = [];
  for (let i = 1; i <= 7; i++) S.push(await Student.create({ name: 'Stu' + i, roll: '10' + i, batch: b._id, semester: sem._id, stats: { presentCount: 8, totalSessions: 10 } }));
  const X = await Student.create({ name: 'Other', roll: '201', batch: other._id, semester: sem._id });
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const cyc = await Cycle.create({ batch: b._id, semester: sem._id, number: 4, startDate: day(-5), endDate: day(5), track: { tracked: true, trackedFrom: day(-6), projectDate: day(3) } });
  await CyclePlan.create({ cycle: cyc._id, batch: b._id, semester: sem._id, classes: [
    { number: 41, title: 'Big O', notes: 'SECRET trainer notes', date: shift(today, -1) },
    { number: 42, title: 'Searching', notes: 'SECRET', date: today },
    { number: 43, title: 'Sorting', notes: 'SECRET', date: shift(today, 1) } ] });
  const prev = await Cycle.create({ batch: b._id, semester: sem._id, number: 3, startDate: day(-30), endDate: day(-10), assessmentHeld: false });
  await CycleMark.create({ cycle: prev._id, batch: b._id, semester: sem._id, student: S[0]._id, status: 'evaluated', project: 80, category: 'excellent' });
  await CycleMark.create({ cycle: prev._id, batch: b._id, semester: sem._id, student: S[1]._id, status: 'evaluated', project: 30, category: 'basic' });

  console.log('\n— join code + sign-in');
  let r = await http('GET', `/api/student-admin/batch/${b._id}`, { token: T(lucky) });
  const code = r.body.joinCode;
  ok('trainer gets a 6-char join code', r.status === 200 && /^[A-Z2-9]{6}$/.test(code), JSON.stringify(r.body).slice(0, 200));
  ok('nobody activated yet', r.body.activated === 0 && r.body.total === 7);
  ok('other batch trainer cannot see it', (await http('GET', `/api/student-admin/batch/${b._id}`, { token: T(deepu) })).status === 403);
  r = await http('POST', '/api/student/activate', { body: { roll: '101', code: 'WRONG1', password: 'secret12' } });
  ok('wrong code refused', r.status === 400);
  r = await http('POST', '/api/student/activate', { body: { roll: '201', code, password: 'secret12' } });
  ok('roll from another batch refused', r.status === 400, JSON.stringify(r.body));
  r = await http('POST', '/api/student/activate', { body: { roll: ' 101 ', code: code.toLowerCase(), password: 'secret12' } });
  ok('activate with roll + code (case/space tolerant)', r.status === 201 && r.body.token, JSON.stringify(r.body));
  const tok1 = r.body.token;
  r = await http('POST', '/api/student/activate', { body: { roll: '101', code, password: 'other123' } });
  ok('cannot activate twice', r.status === 409);
  r = await http('POST', '/api/student/login', { body: { roll: '101', password: 'nope' } });
  ok('wrong password refused', r.status === 401);
  r = await http('POST', '/api/student/login', { body: { roll: '102', password: 'whatever' } });
  ok('not-yet-activated student told to set up first', r.status === 401 && /First time/.test(r.body.message));
  r = await http('POST', '/api/student/login', { body: { roll: '101', password: 'secret12' } });
  ok('login with roll + password', r.status === 200 && r.body.token);
  r = await http('GET', '/api/students?batch=' + b._id, { token: tok1 });
  ok('student token rejected on staff routes', r.status === 401, r.status);
  r = await http('GET', '/api/student/me', { token: T(lucky) });
  ok('staff token rejected on student routes', r.status === 401);
  const list = await http('GET', '/api/students?batch=' + b._id, { token: T(lucky) });
  ok('password hash never in staff student list', !JSON.stringify(list.body).includes('passwordHash'));

  console.log('\n— My cycle');
  r = await http('GET', '/api/student/me', { token: tok1 });
  const me = r.body;
  ok('me: name + batch', me.student?.roll === '101' && me.batch?.name === 'BCA 3 A', JSON.stringify(me).slice(0, 300));
  ok('me: trainers exclude reviewer', me.batch.trainers.join() === 'Lucky');
  ok('me: plan topic + date, no trainer notes', me.cycle.classes.length === 3 && !JSON.stringify(me).includes('SECRET'));
  ok('me: today class marked', me.cycle.classes.find(c => c.number === 42).when === 'today');
  ok('me: attendance %', me.attendance.pct === 80);
  ok('me: own marks only', me.marks.length === 1 && me.marks[0].total === 80 && me.marks[0].outOf === 100 && me.marks[0].category === 'excellent');
  ok('me: project submission closed until the trainer opens it', me.project.state === 'closed');
  ok('me: today pulse question offered', me.pulseToday?.number === 42 && !me.pulseToday.mine);

  console.log('\n— project submission (trainer switch)');
  r = await http('POST', '/api/student/submission', { token: tok1, body: { cycleId: cyc._id, githubUrl: 'https://github.com/a/b' } });
  ok('closed by default', r.status === 400 && /closed/.test(r.body.message), JSON.stringify(r.body));
  ok('other batch trainer cannot open it', (await http('POST', `/api/student-admin/cycle/${cyc._id}/submission`, { token: T(deepu), body: { open: true } })).status === 403);
  r = await http('POST', `/api/student-admin/cycle/${cyc._id}/submission`, { token: T(lucky), body: { open: true } });
  const midnight = perf.istToDate(`${today}T23:59`).toISOString();
  ok('trainer opens it — closes itself at midnight', r.status === 200 && r.body.window.open && new Date(r.body.window.until).toISOString() === midnight, JSON.stringify(r.body));
  ok('student page shows it open', (await http('GET', '/api/student/me', { token: tok1 })).body.project.state === 'open');
  r = await http('POST', '/api/student/submission', { token: tok1, body: { cycleId: cyc._id, githubUrl: 'not a link' } });
  ok('GitHub link required', r.status === 400);
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');
  r = await http('POST', '/api/student/submission', { token: tok1, body: { cycleId: cyc._id, githubUrl: 'https://github.com/stu1/dsa-toolkit', liveUrl: '', note: 'done', screenshot: { data: png, contentType: 'image/png' } } });
  ok('submission saved, not late (before/on project day)', r.status === 201 && r.body.submission.late === false && r.body.submission.hasScreenshot, JSON.stringify(r.body));
  r = await http('GET', `/api/student-admin/cycle/${cyc._id}/submissions`, { token: T(lucky) });
  ok('trainer sees the submission', r.body.submissions.length === 1 && r.body.submissions[0].githubUrl.includes('dsa-toolkit'));
  const shot = await http('GET', `/api/student-admin/submission/${r.body.submissions[0]._id}/screenshot`, { token: T(lucky) });
  ok('screenshot viewable by trainer', /^data:image\/png;base64,/.test(shot.body.dataUrl || ''));
  r = await http('POST', `/api/student-admin/cycle/${cyc._id}/submission`, { token: T(lucky), body: { open: false } });
  ok('trainer closes it', r.status === 200 && r.body.window.open === false);
  r = await http('POST', '/api/student/submission', { token: tok1, body: { cycleId: cyc._id, githubUrl: 'https://github.com/stu1/v2' } });
  ok('closed → refused', r.status === 400);
  r = await http('POST', `/api/student-admin/cycle/${cyc._id}/submission`, { token: T(lucky), body: { open: true, minutes: 30 } });
  ok('reopen for 30 minutes', r.body.window.open && (new Date(r.body.window.until) - Date.now()) <= 30 * 60000 + 2000);
  await Cycle.updateOne({ _id: cyc._id }, { $set: { 'track.projectDate': day(-1) } });
  r = await http('POST', '/api/student/submission', { token: tok1, body: { cycleId: cyc._id, githubUrl: 'https://github.com/stu1/dsa-toolkit-v2' } });
  ok('after the project day → marked late', r.status === 201 && r.body.submission.late === true, JSON.stringify(r.body));
  await Cycle.updateOne({ _id: cyc._id }, { $set: { 'track.projectDate': day(3) } });
  const xt = (await http('POST', '/api/student/activate', { body: { roll: '201', code: (await http('GET', `/api/student-admin/batch/${other._id}`, { token: T(deepu) })).body.joinCode, password: 'secret12' } })).body.token;
  r = await http('POST', '/api/student/submission', { token: xt, body: { cycleId: cyc._id, githubUrl: 'https://github.com/x/y' } });
  ok('student cannot submit to another batch\'s cycle', r.status === 404);

  console.log('\n— class pulse');
  const toks = [tok1];
  for (const s of S.slice(1)) toks.push((await http('POST', '/api/student/activate', { body: { roll: s.roll, code, password: 'secret12' } })).body.token);
  ok('all 7 activated', toks.every(Boolean));
  r = await http('POST', '/api/student/pulse', { token: tok1, body: { covered: 'maybe', understanding: 3 } });
  ok('bad answer refused', r.status === 400);
  const answers = ['no', 'no', 'no', 'no', 'partly', 'yes', 'no'];
  for (let i = 0; i < 7; i++) await http('POST', '/api/student/pulse', { token: toks[i], body: { covered: answers[i], understanding: 2 + (i % 3) } });
  r = await http('POST', '/api/student/pulse', { token: toks[0], body: { covered: 'no', understanding: 2 } });
  ok('answer can be changed (one per student per day)', r.status === 201);
  r = await http('POST', '/api/student/pulse', { token: xt, body: { covered: 'yes', understanding: 5 } });
  ok('no class today for other batch → refused', r.status === 400);
  r = await http('GET', `/api/student-admin/pulse?batch=${b._id}`, { token: T(lucky) });
  const pd = r.body.days?.[0];
  ok('trainer sees totals only', pd && pd.responses === 7 && pd.yes === 1 && pd.no === 5 && !JSON.stringify(r.body).includes('student'), JSON.stringify(r.body));
  await DailyLog.create({ batch: b._id, semester: sem._id, date: perf.ymdToDay(today), status: 'done', loggedBy: lucky._id, firstLoggedBy: lucky._id });
  const period = perf.istYmd(perf.deadlineOf(cyc));
  r = await http('GET', `/api/cycleplans/board?period=${period}`, { token: T(admin) });
  const k42 = r.body.cycles?.find(c => String(c.cycleId) === String(cyc._id))?.classes.find(c => c.number === 42);
  ok('board flags "done" log vs students saying not covered', k42?.pulse?.mismatch === true && k42.pulse.coveredPct < 50, JSON.stringify(k42?.pulse));
  me.pulseToday = (await http('GET', '/api/student/me', { token: tok1 })).body.pulseToday;
  ok('me shows my answer for today', me.pulseToday.mine?.covered === 'no');

  console.log('\n— trainer feedback');
  r = await http('POST', '/api/feedback/windows', { token: T(lucky), body: { batchIds: [b._id], hours: 48 } });
  ok('only admin opens feedback', r.status === 403);
  r = await http('POST', '/api/feedback/windows', { token: T(admin), body: { title: 'Cycle 4 feedback', batchIds: [b._id], hours: 48 } });
  ok('admin opens a window', r.status === 201);
  const wid = r.body.window._id;
  const home = (await http('GET', '/api/student/me', { token: tok1 })).body;
  ok('student sees the form with their (non-review) trainer', home.feedback.length === 1 && home.feedback[0].trainers.length === 1 && home.feedback[0].trainers[0].name === 'Lucky');
  const rat = { clarity: 4, punctuality: 5, help: 4, practical: 3, overall: 4 };
  r = await http('POST', '/api/student/feedback', { token: tok1, body: { windowId: wid, trainerId: md._id, ratings: rat } });
  ok('cannot rate a review account', r.status === 400);
  r = await http('POST', '/api/student/feedback', { token: tok1, body: { windowId: wid, trainerId: lucky._id, ratings: { ...rat, overall: 9 } } });
  ok('ratings must be 1–5', r.status === 400);
  for (let i = 0; i < 4; i++) await http('POST', '/api/student/feedback', { token: toks[i], body: { windowId: wid, trainerId: lucky._id, ratings: rat, comment: i === 0 ? 'Explains well' : '' } });
  r = await http('POST', '/api/student/feedback', { token: tok1, body: { windowId: wid, trainerId: lucky._id, ratings: rat } });
  ok('one feedback per student per trainer', r.status === 409);
  r = await http('POST', '/api/student/feedback', { token: xt, body: { windowId: wid, trainerId: lucky._id, ratings: rat } });
  ok('student of another batch cannot use the form', r.status === 404);
  r = await http('GET', `/api/feedback/windows/${wid}/results`, { token: T(lucky) });
  ok('trainer: hidden below 5 answers', r.body.rows[0].responses === 4 && r.body.rows[0].hidden === true && !r.body.rows[0].averages);
  await http('POST', '/api/student/feedback', { token: toks[4], body: { windowId: wid, trainerId: lucky._id, ratings: rat } });
  r = await http('GET', `/api/feedback/windows/${wid}/results`, { token: T(lucky) });
  ok('trainer: averages at 5 answers, no comments, no names', r.body.rows[0].averages?.clarity === 4 && !r.body.rows[0].comments && !JSON.stringify(r.body).includes('Stu'), JSON.stringify(r.body.rows));
  r = await http('GET', `/api/feedback/windows/${wid}/results`, { token: T(admin) });
  ok('admin: averages + comments (no names)', r.body.rows[0].comments?.[0] === 'Explains well' && !JSON.stringify(r.body).includes('Stu1'));
  ok('other trainer cannot read results', (await http('GET', `/api/feedback/windows/${wid}/results`, { token: T(deepu) })).status === 403);
  await http('PATCH', `/api/feedback/windows/${wid}`, { token: T(admin), body: { close: true } });
  r = await http('POST', '/api/student/feedback', { token: toks[5], body: { windowId: wid, trainerId: lucky._id, ratings: rat } });
  ok('closed window refuses answers', r.status === 400);

  console.log('\n— password reset');
  r = await http('POST', `/api/student-admin/student/${S[0]._id}/reset-password`, { token: T(lucky) });
  ok('trainer resets a password', r.status === 200);
  ok('old token stops working', (await http('GET', '/api/student/me', { token: tok1 })).status === 401);
  r = await http('POST', '/api/student/activate', { body: { roll: '101', code, password: 'newpass12' } });
  ok('student sets up again with the code', r.status === 201);
  r = await http('POST', `/api/student-admin/batch/${b._id}/join-code`, { token: T(lucky) });
  ok('new join code; old one stops working', r.body.joinCode !== code && (await http('POST', '/api/student/activate', { body: { roll: '101', code, password: 'x12345' } })).status === 400);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
