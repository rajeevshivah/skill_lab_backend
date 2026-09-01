// Integration smoke test — runs the real Express app against a throwaway
// MongoDB and checks the behaviour these fixes are about.
//
//   npm run test:integration
//
// Uses mongodb-memory-server (already a dependency), which downloads a mongod
// binary on first run. It never touches your Atlas database.
process.env.JWT_SECRET = 'test-secret';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');

const User      = require('../models/User');
const Semester  = require('../models/Semester');
const Batch     = require('../models/Batch');
const Student   = require('../models/Student');
const Cycle     = require('../models/Cycle');
const CycleMark = require('../models/CycleMark');
const DailyLog  = require('../models/DailyLog');

let pass = 0, fail = 0;
const ok  = (name, cond, extra='') => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); } };

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth',     require('../routes/auth'));
  app.use('/api/students', require('../routes/students'));
  app.use('/api/batches',  require('../routes/batches'));
  app.use('/api/logs',     require('../routes/logs'));
  app.use('/api/cycles',   require('../routes/cycles'));
  app.use('/api/marks',    require('../routes/cyclemarks'));
  app.use('/api/search',   require('../routes/search'));
  app.use('/api/plans',    require('../routes/plans'));
  return app;
}

let server, base;
const req = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const app = makeApp();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // ── fixtures ──
  const admin   = await User.create({ name:'Admin',  email:'admin@x.com',  password:'longpassword1', role:'superadmin' });
  const trainer = await User.create({ name:'Lucky',  email:'lucky@x.com',  password:'longpassword1', role:'trainer' });
  const other   = await User.create({ name:'Deepu',  email:'deepu@x.com',  password:'longpassword1', role:'trainer' });
  const cot     = await User.create({ name:'Co',     email:'co@x.com',     password:'longpassword1', role:'cotrainer' });
  const sem     = await Semester.create({ name:'Odd 2026', status:'active' });
  const batch   = await Batch.create({ name:'BCA 3 A', semester: sem._id, trainers:[trainer._id, other._id, cot._id] });
  const tok = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const A = tok(admin), T = tok(trainer), O = tok(other), C = tok(cot);

  console.log('\n1. Endpoints require authentication');
  ok('GET /students without token → 401', (await req('GET','/api/students')).status === 401);
  ok('GET /students/placement without token → 401', (await req('GET','/api/students/placement')).status === 401);
  ok('GET /batches without token → 401', (await req('GET','/api/batches')).status === 401);
  ok('GET /plans/:id without token → 401', (await req('GET',`/api/plans/${batch._id}`)).status === 401);
  ok('GET /students with token → 200', (await req('GET','/api/students',{token:T})).status === 200);

  console.log('\n2. Import validation and duplicate handling');
  const rows = [
    { roll:'124258090001', name:'Hardik Mishra', course:'BCA', sem:'3rd', section:'A' },
    { roll:'124258090005', name:'Devansh Pandey', course:'BCA', sem:'3rd', section:'A' },
    { roll:'124258090005', name:'Repeat In Paste', course:'BCA', sem:'3rd', section:'A' },
    { roll:'12425 8090009', name:'Bad Roll', course:'BCA', sem:'3rd', section:'A' },
    { roll:'124258090011', name:'', course:'BCA', sem:'3rd', section:'A' },
  ];
  const prev = await req('POST','/api/students/bulk?preview=1',{ token:T, body:{ batch:batch._id, rows } });
  ok('preview imports 2', prev.body?.willImport === 2, JSON.stringify(prev.body));
  ok('preview skips 3', prev.body?.skippedCount === 3, JSON.stringify(prev.body?.skipped));
  ok('preview wrote nothing', (await Student.countDocuments({ batch: batch._id })) === 0);
  ok('preview names the in-paste duplicate',
     !!prev.body?.skipped?.find(s => /duplicate of line 2/.test(s.reason)));
  ok('preview names the bad roll',
     !!prev.body?.skipped?.find(s => /unusual characters/.test(s.reason)));

  const imp1 = await req('POST','/api/students/bulk',{ token:T, body:{ batch:batch._id, rows } });
  ok('import creates 2', imp1.body?.imported === 2);
  const imp2 = await req('POST','/api/students/bulk',{ token:T, body:{ batch:batch._id, rows } });
  ok('re-import creates 0 (no double roster)', imp2.body?.imported === 0, JSON.stringify(imp2.body));
  ok('re-import explains why', /already in this batch/.test(imp2.body?.skipped?.[0]?.reason || ''));
  ok('still 2 students total', (await Student.countDocuments({ batch: batch._id })) === 2);

  const s1 = await Student.findOne({ roll:'124258090001' });
  const s2 = await Student.findOne({ roll:'124258090005' });

  console.log('\n3. Editing a student');
  const ed = await req('PUT',`/api/students/${s1._id}`,{ token:T, body:{ roll:'124258090002', section:'B' } });
  ok('trainer can edit roll + section', ed.status === 200 && ed.body?.student?.roll === '124258090002');
  const clash = await req('PUT',`/api/students/${s1._id}`,{ token:T, body:{ roll:'124258090005' } });
  ok('roll clash inside the batch is refused', clash.status === 400 && /already belongs/.test(clash.body.message));
  const flagOnly = await req('PUT',`/api/students/${s1._id}`,{ token:T, body:{ flagged:true } });
  ok('flag-only update still works', flagOnly.status === 200 && flagOnly.body.student.flagged === true);

  console.log('\n4. Attendance arithmetic');
  const d1 = new Date('2026-08-03'), d2 = new Date('2026-08-04'), d3 = new Date('2026-08-05');
  await req('POST','/api/logs',{ token:T, body:{ batch:batch._id, date:'2026-08-03',
    attendance:[{student:s1._id,present:true},{student:s2._id,present:false}] } });
  await req('POST','/api/logs',{ token:T, body:{ batch:batch._id, date:'2026-08-04',
    attendance:[{student:s1._id,present:true},{student:s2._id,present:true}] } });
  // A log with NO attendance must not count as a session for anyone.
  await req('POST','/api/logs',{ token:T, body:{ batch:batch._id, date:'2026-08-05', notes:'no roll call' } });
  const after = await Student.findById(s1._id);
  ok('sessions counted = 2 (the empty log is excluded)', after.stats.totalSessions === 2,
     `got ${after.stats.totalSessions}`);
  ok('present counted = 2', after.stats.presentCount === 2);

  // Second trainer logs the same day without the full roster — must merge, not wipe.
  await req('POST','/api/logs',{ token:O, body:{ batch:batch._id, date:'2026-08-03',
    attendance:[{ student:s2._id, present:true }] } });
  const log1 = await DailyLog.findOne({ batch:batch._id, date:new Date('2026-08-03T00:00:00.000Z') });
  ok('second trainer merges rather than overwrites', (log1?.attendance || []).length === 2,
     `entries: ${(log1?.attendance||[]).length}`);
  ok('both trainers recorded as contributors', (log1?.contributors || []).length === 2);

  console.log('\n5. Marks sheet');
  const cycle = await Cycle.create({ batch:batch._id, semester:sem._id, number:1,
    startDate:new Date('2026-08-01'), endDate:new Date('2026-08-31') });
  const sheet = await req('GET',`/api/marks/${cycle._id}`,{ token:T });
  ok('marks sheet lists the roster', sheet.body?.rows?.length === 2);
  ok('marks sheet reports sessions held', sheet.body?.sessionsInCycle === 2, `got ${sheet.body?.sessionsInCycle}`);
  ok('marks attendance matches the roster figure',
     sheet.body.rows.find(r => String(r.student) === String(s1._id)).attendancePct === 100);

  const bad = await req('PUT',`/api/marks/${cycle._id}`,{ token:T, body:{ rows:[
    { student:s1._id, status:'evaluated', assessment:80, project:70 },
    { student:s2._id, status:'evaluated', assessment:150, project:10 },
  ] } });
  ok('out-of-range mark rejects the whole sheet', bad.status === 400, JSON.stringify(bad.body));
  ok('nothing was written on rejection', (await CycleMark.countDocuments({ cycle: cycle._id })) === 0);

  const good = await req('PUT',`/api/marks/${cycle._id}`,{ token:T, body:{ rows:[
    { student:s1._id, status:'evaluated', assessment:80, project:70 },
    { student:s2._id, status:'not-evaluated' },
  ] } });
  ok('valid sheet saves', good.status === 200 && good.body.saved === 2);
  const m1 = await CycleMark.findOne({ cycle:cycle._id, student:s1._id });
  ok('category computed from total (150/200 = excellent)', m1.category === 'excellent', m1.category);

  console.log('\n6. Deleting a student with history');
  const del = await req('DELETE',`/api/students/${s1._id}`,{ token:T });
  ok('delete refused for a student with marks', del.status === 409 && del.body.needsForce === true);
  ok('student still there', !!(await Student.findById(s1._id)));
  const delCo = await req('DELETE',`/api/students/${s2._id}`,{ token:C });
  ok('co-trainer cannot delete', delCo.status === 403);
  const forceTrainer = await req('DELETE',`/api/students/${s1._id}?force=1`,{ token:T });
  ok('trainer cannot force-delete', forceTrainer.status === 409);
  const forceAdmin = await req('DELETE',`/api/students/${s1._id}?force=1`,{ token:A });
  ok('admin force-delete removes student and marks',
     forceAdmin.status === 200 && (await CycleMark.countDocuments({ student:s1._id })) === 0);

  console.log('\n7. Login throttling and the last superadmin');
  for (let i = 0; i < 8; i++) await req('POST','/api/auth/login',{ body:{ email:'admin@x.com', password:'wrong' } });
  const blocked = await req('POST','/api/auth/login',{ body:{ email:'admin@x.com', password:'longpassword1' } });
  ok('9th attempt is throttled', blocked.status === 429, JSON.stringify(blocked.body));
  const demote = await req('PATCH',`/api/auth/users/${admin._id}`,{ token:A, body:{ role:'trainer' } });
  ok('last superadmin cannot be demoted', demote.status === 400, JSON.stringify(demote.body));

  console.log('\n8. Search finds a cycle by number');
  const found = await req('GET','/api/search?q=cycle%201',{ token:A });
  ok('search "cycle 1" returns the cycle', (found.body?.cycles || []).length === 1, JSON.stringify(found.body?.cycles));

  console.log('\n9. Deleting a batch leaves nothing behind');
  await req('DELETE',`/api/batches/${batch._id}`,{ token:A });
  const leftovers = await Promise.all([
    Cycle.countDocuments({ batch: batch._id }),
    CycleMark.countDocuments({ batch: batch._id }),
    Student.countDocuments({ batch: batch._id }),
    DailyLog.countDocuments({ batch: batch._id }),
  ]);
  ok('no orphaned cycles / marks / students / logs', leftovers.every(n => n === 0), leftovers.join(','));

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
