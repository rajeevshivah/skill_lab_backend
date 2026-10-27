// SECURITY: sign-ins that end on a password change, the platform-owner lock,
// failed-attempt limits that a forged address does not get round, personal
// student setup codes, checked Top 3 entries (they go on the public page),
// roster-only marks and attendance, one-use AI previews and image storage.
//
//   node tests/security.js        (TEST_MONGO_URI=… to use a running database)
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; fails.push(n); console.log('  FAIL', n, typeof x === 'string' ? x : JSON.stringify(x).slice(0, 300)); } };
const step = (t) => console.log('\n— ' + t);
// a real 1×1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const M = (n) => require('../models/' + n);
  const perf = require('../services/performance');
  // this suite checks personal setup codes, the college default
  const college = await require('./college').setup({ settings: { studentSignup: 'personal' } });
  for (const n of ['User', 'Student', 'Batch', 'Semester', 'CycleMark', 'DailyLog', 'ProjectSubmission']) await M(n).init();
  const app = require('../app');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, { token, body, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(raw !== undefined ? { body: raw } : body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const login = async (email, password = 'longpassword1') => (await http('POST', '/api/auth/login', { body: { email, password } })).body?.token;

  const mk = (name, email, role, extra = {}) => M('User').create({ name, email, password: 'longpassword1', role, ...extra });
  const admin = await mk('Admin', 'admin@x.com', 'superadmin');
  const owner = await mk('Owner', 'owner@x.com', 'superadmin', { platformOwner: true });
  const rohit = await mk('Rohit', 'rohit@x.com', 'trainer');
  const lucky = await mk('Lucky', 'lucky@x.com', 'trainer');
  const mgmt = await mk('MD', 'md@x.com', 'viewer');
  const sem = await M('Semester').create({ name: 'Odd', status: 'active' });
  const DA = await M('Batch').create({ name: 'Data Analyst', track: 'Data', semester: sem._id, trainers: [rohit._id], joinCode: 'DACODE1' });
  const FS = await M('Batch').create({ name: 'Full Stack', track: 'MERN', semester: sem._id, trainers: [lucky._id], joinCode: 'FSCODE1' });
  const add = (b, name, roll) => M('Student').create({ name, roll, batch: b._id, semester: sem._id });
  const asha = await add(DA, 'Asha', 'R001'), bala = await add(DA, 'Bala', 'R002'), chetan = await add(DA, 'Chetan', 'R003');
  const fsOnly = await add(FS, 'Farah', 'F001');

  const tAdmin = await login('admin@x.com'), tOwner = await login('owner@x.com');
  const tRohit = await login('rohit@x.com'), tLucky = await login('lucky@x.com'), tMgmt = await login('md@x.com');
  ok('everyone signs in', [tAdmin, tOwner, tRohit, tLucky, tMgmt].every(Boolean));

  step('Staff passwords');
  let r = await http('POST', '/api/auth/create-user', { token: tAdmin, body: { name: 'New', email: 'new@x.com', password: 'short9chr', role: 'trainer' } });
  ok('a new staff password needs 10+ characters', r.status === 400, r.body);
  r = await http('PATCH', `/api/auth/users/${rohit._id}`, { token: tAdmin, body: { password: 'tooshort' } });
  ok('a reset password needs 10+ characters too', r.status === 400, r.body);
  r = await http('PUT', '/api/auth/password', { token: tLucky, body: { current: 'wrong-password', password: 'brand-new-pass-1' } });
  ok('own change: the current password must be right', r.status === 400, r.body);
  const tLucky2 = await login('lucky@x.com');           // a second sign-in (another device)
  r = await http('PUT', '/api/auth/password', { token: tLucky, body: { current: 'longpassword1', password: 'brand-new-pass-1' } });
  ok('own change works and returns a fresh token', r.status === 200 && r.body.token, r.body);
  const tLuckyNew = r.body.token;
  r = await http('GET', '/api/auth/me', { token: tLucky2 });
  ok('the other sign-in ends', r.status === 401 && /password was changed/i.test(r.body?.message), r.body);
  ok('the fresh token works', (await http('GET', '/api/auth/me', { token: tLuckyNew })).status === 200);
  ok('the new password signs in', !!(await login('lucky@x.com', 'brand-new-pass-1')));
  r = await http('PATCH', `/api/auth/users/${lucky._id}`, { token: tAdmin, body: { password: 'admin-set-pass-1' } });
  ok('admin reset works', r.status === 200, r.body);
  ok('…and ends their sign-ins', (await http('GET', '/api/auth/me', { token: tLuckyNew })).status === 401);
  const tLucky3 = await login('lucky@x.com', 'admin-set-pass-1');

  step('Platform owner lock');
  ok('a college admin cannot change the owner', (await http('PATCH', `/api/auth/users/${owner._id}`, { token: tAdmin, body: { role: 'trainer' } })).status === 403);
  ok('…or reset the owner\'s password', (await http('PATCH', `/api/auth/users/${owner._id}`, { token: tAdmin, body: { password: 'takeover-pass-1' } })).status === 403);
  ok('…or delete the owner', (await http('DELETE', `/api/auth/users/${owner._id}`, { token: tAdmin })).status === 403);
  ok('the owner still signs in', !!(await login('owner@x.com')));

  step('Student sign-up: personal setup codes');
  ok('only the admin changes the sign-up mode', (await http('PUT', '/api/settings/student-signup', { token: tRohit, body: { mode: 'batch' } })).status === 403);
  ok('mode is personal', (await http('GET', '/api/settings/student-signup', { token: tRohit })).body?.mode === 'personal');
  r = await http('GET', `/api/student-admin/batch/${DA._id}`, { token: tRohit });
  const codeOf = (roll) => r.body.students.find(s => s.roll === roll)?.setupCode;
  ok('the trainer sees a code for each student, no batch code', r.status === 200 && r.body.mode === 'personal' && !r.body.joinCode && codeOf('R001') && codeOf('R002') && codeOf('R001') !== codeOf('R002'), r.body);
  const ashaCode = codeOf('R001'), balaCode = codeOf('R002');
  const again = await http('GET', `/api/student-admin/batch/${DA._id}`, { token: tRohit });
  ok('codes stay the same between visits', again.body.students.find(s => s.roll === 'R001').setupCode === ashaCode);
  r = await http('GET', `/api/student-admin/batch/${DA._id}`, { token: tMgmt });
  ok('management sees the list but no codes', r.status === 200 && r.body.students.every(s => !s.setupCode), r.body);
  ok('a trainer of another batch sees nothing', (await http('GET', `/api/student-admin/batch/${DA._id}`, { token: tLucky3 })).status === 403);

  const act = (roll, code, password = 'student-pw1') => http('POST', '/api/student/activate', { body: { roll, code, password } });
  const r1 = await act('R001', balaCode), r2 = await act('R999', ashaCode), r3 = await act('R001', 'DACODE1');
  ok('someone else\'s code does not work', r1.status === 400);
  ok('wrong roll and wrong code get the same answer', r1.body.message === r2.body.message && r2.body.message === r3.body.message, [r1.body, r2.body]);
  ok('in personal mode the batch code does not work', r3.status === 400);
  ok('student password needs 8+ characters', (await act('R001', ashaCode, 'short')).status === 400);
  r = await act('R001', ashaCode.toLowerCase());
  ok('own code works (any letter case)', r.status === 201 && r.body.token, r.body);
  let tAsha = r.body.token;
  ok('a used code cannot set up again', (await act('R001', ashaCode)).status === 400);
  ok('the code is gone once set up', !(await M('Student').findById(asha._id).select('+login.setupCode')).login.setupCode);
  ok('a set-up student gets no new code', (await http('POST', `/api/student-admin/student/${asha._id}/new-code`, { token: tRohit })).status === 400);
  r = await http('POST', `/api/student-admin/student/${bala._id}/new-code`, { token: tRohit });
  ok('a new code replaces the old one', r.status === 200 && r.body.setupCode !== balaCode && (await act('R002', balaCode)).status === 400, r.body);
  ok('…and the new one works', (await act('R002', r.body.setupCode)).status === 201);

  const tAsha2 = (await http('POST', '/api/student/login', { body: { roll: 'R001', password: 'student-pw1' } })).body?.token;
  r = await http('PUT', '/api/student/password', { token: tAsha, body: { current: 'student-pw1', password: 'student-pw2' } });
  ok('student changes own password, gets a fresh token', r.status === 200 && r.body.token, r.body);
  tAsha = r.body.token;
  ok('the student\'s other sign-in ends', (await http('GET', '/api/student/me', { token: tAsha2 })).status === 401);
  ok('the fresh one works', (await http('GET', '/api/student/me', { token: tAsha })).status === 200);
  r = await http('POST', `/api/student-admin/student/${asha._id}/reset-password`, { token: tRohit });
  ok('trainer reset gives a new personal code', r.status === 200 && /^[A-Z0-9]{6,}$/.test(r.body.setupCode || ''), r.body);
  ok('…and signs the student out', (await http('GET', '/api/student/me', { token: tAsha })).status === 401);
  ok('…and the old password stops working', (await http('POST', '/api/student/login', { body: { roll: 'R001', password: 'student-pw2' } })).status === 401);
  ok('they set up again with the new code', (await act('R001', r.body.setupCode, 'student-pw3')).status === 201);

  step('Student sign-up: batch mode still works');
  ok('admin switches to batch mode', (await http('PUT', '/api/settings/student-signup', { token: tAdmin, body: { mode: 'batch' } })).body?.mode === 'batch');
  r = await http('GET', `/api/student-admin/batch/${DA._id}`, { token: tRohit });
  ok('batch mode shows the batch code, no personal codes', r.body.mode === 'batch' && r.body.joinCode === 'DACODE1' && r.body.students.every(s => !s.setupCode), r.body);
  ok('Chetan sets up with the batch code', (await act('R003', 'DACODE1')).status === 201);
  ok('another batch\'s code does not work', (await act('F001', 'DACODE1')).status === 400);
  await http('PUT', '/api/settings/student-signup', { token: tAdmin, body: { mode: 'personal' } });

  step('Marks and attendance only for the batch\'s own students');
  const today = perf.istYmd(new Date());
  const cyc = await M('Cycle').create({ batch: DA._id, semester: sem._id, number: 1, startDate: perf.ymdToDay(today), endDate: perf.ymdToDay(today), track: { projectDate: perf.ymdToDay(today) } });
  r = await http('PUT', `/api/marks/${cyc._id}`, { token: tRohit, body: { rows: [{ student: asha._id, assessment: 80, project: 70 }, { student: fsOnly._id, assessment: 99, project: 99 }] } });
  ok('a mark row for another batch\'s student is refused, nothing saved', r.status === 400 && !(await M('CycleMark').exists({ cycle: cyc._id })), r.body);
  r = await http('POST', '/api/logs', { token: tRohit, body: { batch: DA._id, date: today, status: 'done', topicsCovered: [], attendance: [{ student: asha._id, present: true }, { student: fsOnly._id, present: true }] } });
  const log = await M('DailyLog').findOne({ batch: DA._id });
  ok('attendance keeps only the batch\'s students', r.status < 300 && log && log.attendance.length === 1 && String(log.attendance[0].student) === String(asha._id), r.body);

  step('Top 3 (shown on the public Hall of Fame)');
  const rep = (top3) => http('PUT', `/api/cycles/${cyc._id}/report`, { token: tAdmin, body: { top3 } });
  ok('at most 3 places', (await rep([1, 2, 3, 1].map((k, i) => ({ rank: k, name: 'N' + i })))).status === 400);
  ok('ranks are 1–3', (await rep([{ rank: 7, name: 'X' }])).status === 400);
  ok('links must be GitHub https links', (await rep([{ rank: 1, name: 'X', github: 'javascript:alert(1)' }])).status === 400);
  ok('a photo must be a real image', (await rep([{ rank: 1, name: 'X', photo: 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64') }])).status === 400);
  r = await rep([{ rank: 1, student: asha._id, name: 'Asha', roll: 'R001', github: 'https://github.com/asha', photo: 'data:image/png;base64,' + PNG },
                 { rank: 2, student: bala._id, name: 'Bala'.repeat(40), roll: 'R002' }]);
  ok('a good Top 3 saves', r.status === 200, r.body);
  r = await http('GET', `/api/cycles/${cyc._id}`, { token: tAdmin });
  const t1 = r.body.cycle.report.top3.find(t => t.rank === 1), t2 = r.body.cycle.report.top3.find(t => t.rank === 2);
  ok('names are cut to 80 characters', t2.name.length === 80);
  ok('the report gets a photo address, not the image', t1.photo?.url && !t1.photo.data && !r.text.includes(PNG.slice(0, 30)), t1.photo);
  const img = await http('GET', t1.photo.url.replace(/^\/cycles/, '/api/cycles'));
  ok('the photo is served as an image, not sniffed', img.status === 200 && img.headers.get('content-type') === 'image/png' && img.headers.get('x-content-type-options') === 'nosniff', [img.status, img.headers.get('content-type')]);
  r = await rep([{ rank: 1, student: bala._id, name: 'Bala', roll: 'R002', photo: null },
                 { rank: 2, student: asha._id, name: 'Asha', roll: 'R001', github: 'https://github.com/asha', photo: 'keep' }]);
  const moved = (await M('Cycle').findById(cyc._id)).report.top3.find(t => t.rank === 2);
  ok('"keep" keeps a student\'s photo when they change place', r.status === 200 && moved.photo?.data === PNG, r.body);
  const pub = await http('GET', '/api/cycles/halloffame');
  ok('the public page carries no photo bytes', pub.status === 200 && !pub.text.includes(PNG.slice(0, 30)));

  step('Project screenshots');
  await M('Cycle').updateOne({ _id: cyc._id }, { $set: { 'submission.open': true, 'submission.until': new Date(Date.now() + 3600e3) } });
  await http('POST', `/api/student-admin/cycle/${cyc._id}/submission`, { token: tRohit, body: { open: true, minutes: 60 } });
  tAsha = (await http('POST', '/api/student/login', { body: { roll: 'R001', password: 'student-pw3' } })).body?.token;
  r = await http('POST', '/api/student/submission', { token: tAsha, body: { cycleId: cyc._id, githubUrl: 'https://github.com/asha/p', screenshot: { contentType: 'image/png', data: PNG } } });
  ok('a submission with a screenshot saves', r.status === 201, r.body);
  r = await http('POST', '/api/student/submission', { token: tAsha, body: { cycleId: cyc._id, githubUrl: 'https://github.com/asha/p', screenshot: { contentType: 'image/png', data: Buffer.from('not an image').toString('base64') } } });
  ok('a fake screenshot is refused', r.status === 400, r.body);
  const sub = await M('ProjectSubmission').findOne({ cycle: cyc._id });
  r = await http('GET', `/api/student-admin/submission/${sub._id}/screenshot`, { token: tRohit });
  ok('the trainer sees the screenshot', r.status === 200 && r.body.dataUrl === `data:image/png;base64,${PNG}`, r.body);
  ok('another batch\'s trainer does not', (await http('GET', `/api/student-admin/submission/${sub._id}/screenshot`, { token: tLucky3 })).status === 403);

  step('Class plans');
  const ps = require('../services/planStore');
  const adminUser = await M('User').findById(admin._id);
  r = await ps.editPlan(adminUser, cyc._id, () => [{ number: 1, title: 'Intro', time: '<img src=x onerror=alert(1)>' }, { number: 2, title: 'Two', time: '10:00 - 11:30' }], { skipLock: true });
  const plan = await M('CyclePlan').findOne({ cycle: cyc._id }).lean();
  ok('a class time must be a clock time', r.status === 200 && plan.classes[0].time === '' && plan.classes[1].time === '10:00 - 11:30', r.body);
  r = await ps.editPlan(adminUser, cyc._id, (l) => l.map(k => k.number === 1 ? { ...k, trainer: lucky._id } : k), { skipLock: true });
  ok('a class trainer must be on the batch', r.status === 400, r.body);

  step('AI previews work once');
  const confirm = require('../mcp/confirm');
  const tok = confirm.makePreviewToken(admin._id, 'some_tool', { a: 1 });
  ok('a preview confirms once', confirm.checkPreviewToken(admin._id, 'some_tool', { a: 1 }, tok) === null);
  ok('…not twice', /already confirmed/.test(confirm.checkPreviewToken(admin._id, 'some_tool', { a: 1 }, tok) || ''));
  const tok2 = confirm.makePreviewToken(admin._id, 'some_tool', { a: 1 });
  ok('…and not for other arguments', /changed/.test(confirm.checkPreviewToken(admin._id, 'some_tool', { a: 2 }, tok2) || ''));

  step('Image storage without R2 (kept in the record)');
  const files = require('../services/fileStore');
  const stored = await files.store({ data: PNG, contentType: 'image/png' }, 'photos');
  ok('stored in the record when storage is not set up', !files.enabled() && stored.data === PNG && !stored.key);
  ok('reads back', files.has(stored) && (await files.dataUrl(stored)) === `data:image/png;base64,${PNG}` && files.publicUrl(stored) === null);
  ok('nothing stored for nothing', !files.has(await files.store(null, 'photos')));

  step('Server answers');
  r = await http('POST', '/api/auth/login', { raw: '{"email": broken' });
  ok('broken JSON → 400, no details', r.status === 400 && !/SyntaxError|at /.test(r.text), r.text);
  ok('no x-powered-by', !r.headers.get('x-powered-by'));

  step('Failed-attempt limits (a forged address does not help)');
  // like Render: the proxy adds the real address last, whatever the caller wrote before it
  const ip = () => `${1 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.1.${Math.floor(Math.random() * 250)}, 203.0.113.7`;
  let last;
  for (let i = 0; i < 9; i++) last = await http('POST', '/api/auth/login', { headers: { 'X-Forwarded-For': ip() }, body: { email: 'rohit@x.com', password: 'nope-' + i } });
  ok('8 wrong passwords lock that account for a while, whatever address is claimed', last.status === 429, last.body);
  for (let i = 0; i < 31; i++) last = await http('POST', '/api/auth/login', { headers: { 'X-Forwarded-For': ip() }, body: { email: `guess${i}@x.com`, password: 'nope' } });
  ok('30 wrong tries from one place lock that place, even with forged X-Forwarded-For', last.status === 429, last.body);
  for (let i = 0; i < 9; i++) last = await act('R003', 'WRONG' + i);
  ok('student set-up guesses are limited too', last.status === 429, last.body);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log('Failed:', fails.join(' | '));
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
