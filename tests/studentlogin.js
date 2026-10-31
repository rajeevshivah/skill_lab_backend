// ONE student sign-in for every module (Person.login): the move from the old
// per-batch sign-ins, older sign-ins still working, setup / reset / sign-out,
// several batch places, the profile (checks, consent, completion), photo,
// a student in no batch, staff views.   node tests/studentlogin.js
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; fails.push(n); console.log('  FAIL', n, typeof x === 'string' ? x : JSON.stringify(x).slice(0, 400)); } };
const step = (t) => console.log('\n— ' + t);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  // Real MongoDB (4.4+) refuses a projection with a path AND its parent ({ login: 1, 'login.passwordHash': 1 }:
  // "Path collision"); the test database does not — so every query is checked here.
  const collisions = [];
  mongoose.set('debug', (coll, method, ...args) => {
    const proj = args.find(a => a && typeof a === 'object' && a.projection)?.projection;
    if (!proj) return;
    const keys = Object.keys(proj);
    for (const k of keys) if (keys.some(o => o !== k && k.startsWith(o + '.'))) collisions.push(`${coll}.${method}: ${keys.join(', ')}`);
  });
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const M = (n) => require('../models/' + n);
  const college = await require('./college').setup({ settings: { studentSignup: 'personal' } });
  for (const n of ['User', 'Student', 'Person', 'Batch', 'Semester']) await M(n).init();
  const app = require('../app');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const staffLogin = async (email) => (await http('POST', '/api/auth/login', { body: { email, password: 'longpassword1' } })).body?.token;
  const people = require('../services/people');
  const access = require('../services/studentAccess');

  const admin = await M('User').create({ name: 'Admin', email: 'admin@x.com', password: 'longpassword1', role: 'superadmin' });
  const rohit = await M('User').create({ name: 'Rohit', email: 'rohit@x.com', password: 'longpassword1', role: 'trainer' });
  const tAd = await staffLogin('admin@x.com'), tRo = await staffLogin('rohit@x.com');
  const old = await M('Semester').create({ name: 'Even 2025-26', status: 'archived', startDate: new Date('2026-01-12') });
  const sem = await M('Semester').create({ name: 'Odd 2026-27', status: 'active', startDate: new Date('2026-07-20') });
  const DA = await M('Batch').create({ name: 'Data Analyst', track: 'Data', semester: sem._id, trainers: [rohit._id], joinCode: 'DACODE1' });
  const FS = await M('Batch').create({ name: 'Full Stack', track: 'MERN', semester: sem._id, trainers: [rohit._id], joinCode: 'FSCODE1' });
  const OLDB = await M('Batch').create({ name: 'Old batch', semester: old._id, isActive: false });
  const hash = await bcrypt.hash('oldpass123', 10);

  step('Before the move: sign-ins on the batch records');
  // Asha set up last semester (old batch) and again this semester (newer sign-in) — the newer one must win
  const ashaOld = await M('Student').create({ name: 'Asha Rai', roll: 'R001', batch: OLDB._id, semester: old._id, course: 'BCA', sem: '2',
    login: { passwordHash: await bcrypt.hash('veryold-pw', 10), activatedAt: new Date('2026-02-01'), lastLoginAt: new Date('2026-03-01') } });
  const asha = await M('Student').create({ name: 'Asha Rai', roll: 'R001', batch: DA._id, semester: sem._id, course: 'BCA', sem: '3', section: 'A',
    login: { passwordHash: hash, activatedAt: new Date('2026-08-01'), lastLoginAt: new Date('2026-10-20'), tokenVersion: 2 } });
  const ashaFS = await M('Student').create({ name: 'Asha Rai', roll: 'R001', batch: FS._id, semester: sem._id, course: 'BCA', sem: '3', section: 'A' });
  const bala = await M('Student').create({ name: 'Bala', roll: 'R002', batch: DA._id, semester: sem._id, course: 'BCA', sem: '3' });
  const chetan = await M('Student').create({ name: 'Chetan', roll: 'R003', batch: FS._id, semester: sem._id, course: 'B.Tech', sem: '3' });
  await people.link({ apply: true });
  const ashaP = (await M('Student').findById(asha._id)).person;
  // a sign-in token made before the move: { sid }
  const oldToken = jwt.sign({ sid: asha._id, kind: 'student', org: college._id, v: 2 }, process.env.JWT_SECRET, { expiresIn: '30d' });
  ok('the person has no sign-in yet', !(await M('Person').findById(ashaP).select('+login.passwordHash')).login.passwordHash);
  let r = await http('GET', '/api/student/me', { token: oldToken });
  ok('an older sign-in still opens the app (and moves the sign-in over)', r.status === 200 && r.body.person?.roll === 'R001', r.body);
  ok('…the newest sign-in was copied', await bcrypt.compare('oldpass123', (await M('Person').findById(ashaP).select('+login.passwordHash')).login.passwordHash));
  ok('moving again does nothing', (await access.moveLogins()).moved === 0);

  step('Sign in once, see every batch');
  r = await http('POST', '/api/student/login', { body: { roll: 'r001 ', password: 'oldpass123' } });
  const tAsha = r.body.token;
  ok('sign in with roll + the same password', r.status === 200 && jwt.decode(tAsha).pid === String(ashaP), r.body);
  ok('the very old password does not work', (await http('POST', '/api/student/login', { body: { roll: 'R001', password: 'veryold-pw' } })).status === 401);
  r = await http('GET', '/api/student/me', { token: tAsha });
  ok('home: all places, current batch first, old one last', r.status === 200 && r.body.places.length === 3 && r.body.places[2].batch === 'Old batch' && r.body.places[0].current && !r.body.places[2].current, r.body.places);
  ok('home: training part for the current place', r.body.batch?.name === r.body.places[0].batch && r.body.student?.roll === 'R001');
  ok('home: modules + profile completion', r.body.modules.training === true && r.body.profile.percent === 0 && r.body.profile.missing.includes('Mobile number'), r.body.profile);
  r = await http('GET', '/api/student/me', { token: tAsha, headers: { 'x-place': String(ashaFS._id) } });
  ok('switch batch with x-place', r.body.batch?.name === 'Full Stack' && r.body.place === String(ashaFS._id));
  r = await http('GET', '/api/student/me', { token: tAsha, headers: { 'x-place': String(bala._id) } });
  ok('someone else\'s place is ignored', r.body.place !== String(bala._id) && r.body.student?.roll === 'R001');

  step('First-time setup (personal code) sets ONE sign-in');
  const codes = (await http('GET', `/api/student-admin/batch/${DA._id}`, { token: tRo })).body;
  const balaCode = codes.students.find(s => s.roll === 'R002').setupCode;
  ok('staff page: Asha shows as set up (from her main record), no code for her', codes.students.find(s => s.roll === 'R001').activated === true && !codes.students.find(s => s.roll === 'R001').setupCode && !!balaCode, codes.students);
  r = await http('POST', '/api/student/activate', { body: { roll: 'R002', code: balaCode, password: 'bala-pass1' } });
  const balaP = (await M('Student').findById(bala._id)).person;
  ok('set up → sign-in on the main record', r.status === 201 && (await M('Person').findById(balaP)).login.activatedAt && jwt.decode(r.body.token).pid === String(balaP), r.body);
  ok('again → "already set up"', (await http('POST', '/api/student/activate', { body: { roll: 'R002', code: balaCode, password: 'bala-pass1' } })).status !== 201);
  const ashaCodeFS = (await http('GET', `/api/student-admin/batch/${FS._id}`, { token: tRo })).body.students.find(s => s.roll === 'R001');
  ok('her other batch shows set up too, no code', ashaCodeFS.activated === true && !ashaCodeFS.setupCode, ashaCodeFS);

  step('Batch-code setup');
  await M('Organization').updateOne({ _id: college._id }, { $set: { 'settings.studentSignup': 'batch' } }); require('../middleware/org').forget();
  r = await http('POST', '/api/student/activate', { body: { roll: 'R003', code: 'FSCODE1', password: 'chetan-pw1' } });
  ok('roll + batch code works', r.status === 201, r.body);
  ok('wrong batch code refused', (await http('POST', '/api/student/activate', { body: { roll: 'R003', code: 'DACODE1', password: 'x-pass-12' } })).status === 400);
  await M('Organization').updateOne({ _id: college._id }, { $set: { 'settings.studentSignup': 'personal' } }); require('../middleware/org').forget();

  step('Password change, trainer reset, sign everyone out');
  r = await http('PUT', '/api/student/password', { token: tAsha, body: { current: 'oldpass123', password: 'newpass456' } });
  const tAsha2 = r.body.token;
  ok('password changed, new sign-in returned', r.status === 200 && !!tAsha2);
  ok('…older sign-ins end (new-style and pre-move)', (await http('GET', '/api/student/me', { token: tAsha })).status === 401 && (await http('GET', '/api/student/me', { token: oldToken })).status === 401);
  ok('…new password works', (await http('POST', '/api/student/login', { body: { roll: 'R001', password: 'newpass456' } })).status === 200);
  r = await http('POST', `/api/student-admin/student/${ashaFS._id}/reset-password`, { token: tRo });
  ok('trainer resets (from any of her batches) → new code', r.status === 200 && /^[A-Z0-9]{6}$/.test(r.body.setupCode), r.body);
  ok('…her sign-ins end and the password is gone', (await http('GET', '/api/student/me', { token: tAsha2 })).status === 401 && (await http('POST', '/api/student/login', { body: { roll: 'R001', password: 'newpass456' } })).status === 401);
  ok('…the very old batch record cannot bring the old password back', (await access.moveLogins()).moved === 0 && (await http('POST', '/api/student/login', { body: { roll: 'R001', password: 'veryold-pw' } })).status === 401);
  r = await http('POST', '/api/student/activate', { body: { roll: 'R001', code: r.body.setupCode, password: 'fresh-pass1' } });
  const tAsha3 = r.body.token;
  ok('she sets up again with the new code', r.status === 201, r.body);
  r = await http('POST', '/api/auth/sign-out-all', { token: tAd, body: { staff: false, students: true } });
  ok('sign out all students ends their sign-ins', r.status === 200 && r.body.students === 3 && (await http('GET', '/api/student/me', { token: tAsha3 })).status === 401, r.body);
  const tA = (await http('POST', '/api/student/login', { body: { roll: 'R001', password: 'fresh-pass1' } })).body.token;
  const tB = (await http('POST', '/api/student/login', { body: { roll: 'R002', password: 'bala-pass1' } })).body.token;

  step('Profile');
  r = await http('GET', '/api/student/profile', { token: tA });
  ok('empty profile, consent not given', r.status === 200 && r.body.profile.phone === '' && !r.body.profile.consentGiven && r.body.profile.completion.total === 5, r.body);
  const P = (body, tok = tA) => http('PUT', '/api/student/profile', { token: tok, body });
  ok('first save needs consent', (await P({ phone: '9876543210' })).status === 400);
  ok('bad mobile refused', (await P({ phone: '12345', consent: true })).status === 400);
  ok('bad email refused', (await P({ email: 'asha@', consent: true })).status === 400);
  ok('bad LinkedIn refused', (await P({ linkedin: 'https://facebook.com/asha', consent: true })).status === 400);
  r = await P({ phone: '+91 98765-43210', email: 'Asha.Rai@Gmail.com', linkedin: 'linkedin.com/in/asha-rai', github: 'https://github.com/asharai', consent: true });
  ok('saved: mobile 10 digits, email lower case, https added', r.status === 200 && r.body.profile.phone === '9876543210' && r.body.profile.email === 'asha.rai@gmail.com'
    && r.body.profile.linkedin === 'https://linkedin.com/in/asha-rai' && r.body.profile.consentGiven, r.body);
  ok('…shown as not verified', r.body.profile.phoneVerified === false && r.body.profile.emailVerified === false);
  ok('…4 of 5 done (photo missing)', r.body.profile.completion.percent === 80 && r.body.profile.completion.missing.join() === 'Photo', r.body.profile.completion);
  ok('GitHub goes to every batch place', (await M('Student').find({ person: ashaP })).every(s => s.github === 'https://github.com/asharai'));
  await M('ProfileField').create({ key: 'tenth_percent', label: '10th %', type: 'number', min: 0, max: 100, editableBy: 'student', required: true });
  await M('ProfileField').create({ key: 'staff_note', label: 'Staff note', type: 'text', editableBy: 'staff' });
  r = await http('GET', '/api/student/profile', { token: tA });
  ok('college field for students shows (staff-only one does not)', r.body.profile.fields.length === 1 && r.body.profile.fields[0].key === 'tenth_percent' && r.body.profile.completion.total === 6);
  ok('staff-only field refused', (await P({ custom: { staff_note: 'x' } })).status === 400);
  ok('out of range refused', (await P({ custom: { tenth_percent: 140 } })).status === 400);
  r = await P({ custom: { tenth_percent: '88' } });
  ok('college field saved', r.status === 200 && r.body.profile.custom.tenth_percent === 88 && r.body.profile.completion.done === 5, r.body.profile);
  r = await P({ phone: '9123456780' });
  ok('changing the mobile keeps it unverified, consent asked only once', r.status === 200 && r.body.profile.phone === '9123456780');

  step('Photo on every place + the main record');
  r = await http('PUT', '/api/student/photo', { token: tA, body: { photo: `data:image/png;base64,${PNG}` } });
  ok('photo saved', r.status === 200 && r.body.hasPhoto, r.body);
  ok('…on the main record and every batch place', !!(await M('Person').findById(ashaP)).photo.contentType && (await M('Student').find({ person: ashaP })).every(s => s.photo?.contentType === 'image/png'));
  ok('…profile complete', (await http('GET', '/api/student/me', { token: tA })).body.profile.percent === 100);

  step('Staff see the sign-in and profile on the person');
  r = await http('GET', `/api/people/${ashaP}`, { token: tAd });
  ok('get person: signed in, profile %, contact not verified, consent date', r.status === 200 && r.body.person.signIn.setUp && r.body.person.profileComplete.percent === 100
    && r.body.person.contact.phone === '9123456780' && r.body.person.contact.phoneVerified === false && !!r.body.person.profileConsentAt, r.body.person);
  ok('the password hash is never sent', !JSON.stringify(r.body).includes('passwordHash') && !JSON.stringify(r.body).includes('$2a$'));

  step('A student in no batch (e.g. placement only)');
  const solo = await M('Person').create({ name: 'Solo', roll: 'P900', source: 'import', login: { passwordHash: await bcrypt.hash('solo-pass1', 10), activatedAt: new Date() } });
  r = await http('POST', '/api/student/login', { body: { roll: 'P900', password: 'solo-pass1' } });
  const tS = r.body.token;
  ok('can sign in', r.status === 200 && !!tS, r.body);
  r = await http('GET', '/api/student/me', { token: tS });
  ok('home works with no batch', r.status === 200 && r.body.places.length === 0 && r.body.place === null && !r.body.batch, r.body);
  ok('training actions say "not in a batch"', (await http('POST', '/api/student/pulse', { token: tS, body: { covered: 'yes', understanding: 4 } })).status === 404);
  ok('profile still works', (await http('PUT', '/api/student/profile', { token: tS, body: { phone: '9988776655', consent: true } })).status === 200);
  ok('photo works without a batch', (await http('PUT', '/api/student/photo', { token: tS, body: { photo: `data:image/png;base64,${PNG}` } })).status === 200 && !!(await M('Person').findById(solo._id)).photo.contentType);

  step('Demo accounts save nothing');
  const demoRec = await M('Student').create({ name: 'MD Demo', roll: 'DEMO1', batch: DA._id, semester: sem._id, demo: true });
  await people.link({ apply: true });
  await access.moveLogins();
  const demoP = (await M('Student').findById(demoRec._id).setOptions({ withDemo: true })).person;
  await M('Person').updateOne({ _id: demoP }, { $set: { 'login.passwordHash': await bcrypt.hash('demo-pass1', 10), 'login.activatedAt': new Date() } });
  const tD = (await http('POST', '/api/student/login', { body: { roll: 'DEMO1', password: 'demo-pass1' } })).body.token;
  r = await http('PUT', '/api/student/profile', { token: tD, body: { phone: '9876501234', consent: true } });
  ok('demo profile not saved', r.status === 200 && r.body.demo && !(await M('Person').findById(demoP)).contact.phone, r.body);

  step('A course filled in later reaches the main record');
  const anjali = await M('Student').create({ name: 'Anjali Singh', roll: '6460431', batch: DA._id, semester: sem._id, sem: '1' });
  await people.link({ apply: true });
  ok('no course → no programme', !(await M('Person').findById((await M('Student').findById(anjali._id)).person)).academic.programme);
  r = await http('PUT', `/api/students/${anjali._id}`, { token: tRo, body: { course: 'BCA' } });
  const anjP = await M('Person').findById((await M('Student').findById(anjali._id)).person).populate('academic.programme academic.cohort').lean();
  ok('trainer fills the course → programme + cohort set', r.status === 200 && anjP.academic.programme?.code === 'BCA' && anjP.academic.cohort?.admissionYear === 2026, anjP.academic);

  step('Wrong tokens');
  ok('a staff token is not a student token', (await http('GET', '/api/student/me', { token: tAd })).status === 401);
  ok('a student token is not a staff token', (await http('GET', '/api/people', { token: tA })).status === 401);
  ok('a token for a person of another college fails', (await http('GET', '/api/student/me', { token: jwt.sign({ pid: new mongoose.Types.ObjectId(), kind: 'student', v: 0 }, process.env.JWT_SECRET) })).status === 401);

  step('Every query works on real MongoDB');
  ok('no query asks for a path and its parent together', collisions.length === 0, [...new Set(collisions)]);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED:', fails.join(' | '));
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
