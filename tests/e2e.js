// END-TO-END: one full cycle (and the start of the next) lived day by day through
// the real website routes, with a simulated clock. Nothing is mocked except time.
//
//   Planning meeting → admin sets timetables and plans the cycle (with a holiday)
//   → trainers type topics (then the plan locks) → students sign in with the batch code
//   → class days: student "was it covered?" pulse, trainer daily logs (on time, late,
//     incomplete, missing), daily review meeting with notes
//   → a surprise holiday mid-cycle moves classes + project day
//   → project day: submission switch, student submissions, trainer feedback form
//   → marks → Top 3 → Hall of Fame (automatically) → report → Performance scores
//   → cycle review meeting → admin closes the cycle → student sees results
//   → next cycle planned; Hall of Fame keeps the last finished cycle until the next
//     one's marks are complete.
//
//   npm run test:e2e        (TEST_MONGO_URI=… to use a running database)
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const FakeTimers = require('@sinonjs/fake-timers');
const perf = require('../services/performance');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; fails.push(n); console.log('  FAIL', n, typeof x === 'string' ? x : JSON.stringify(x).slice(0, 300)); } };
const step = (t) => console.log('\n— ' + t);

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
  }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const college = await require('./college').setup();
  for (const n of ['User', 'Semester', 'Batch', 'Student', 'Cycle', 'CyclePlan', 'CycleMark', 'DailyLog', 'Holiday', 'ClassPulse', 'ProjectSubmission', 'MeetingNote']) await require('../models/' + n).init();

  // ── simulated clock (India time) ──
  const clock = FakeTimers.install({ toFake: ['Date'], now: perf.istToDate('2026-12-31T10:00') });
  const at = (ymd, hm = '10:00') => clock.setSystemTime(perf.istToDate(`${ymd}T${hm}`));

  const app = require('../app');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const M = (n) => require('../models/' + n);
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET, { expiresIn: '7d' });   // fresh each call (clock moves)

  // ── people ──
  const admin = await M('User').create({ name: 'Rajeev', email: 'admin@x.com', password: 'longpassword1', role: 'superadmin' });
  const deepu = await M('User').create({ name: 'Deepu', email: 'deepu@x.com', password: 'longpassword1', role: 'trainer' });
  const lucky = await M('User').create({ name: 'Lucky', email: 'lucky@x.com', password: 'longpassword1', role: 'trainer' });
  const sem = await M('Semester').create({ name: 'Even 2027', status: 'active' });
  const A = await M('Batch').create({ name: 'Full Stack', track: 'MERN', semester: sem._id, trainers: [deepu._id] });
  const B = await M('Batch').create({ name: 'BCA 1st', track: 'C', semester: sem._id, trainers: [lucky._id] });

  step('Setup: rosters through the website (bulk add)');
  const names = ['Aman', 'Bhavna', 'Chetan', 'Divya', 'Esha', 'Farhan'];
  let r = await http('POST', '/api/students/bulk', { token: T(deepu), body: { batch: A._id, rows: names.map((n, i) => ({ name: n, roll: `A10${i}` })) } });
  ok('trainer adds 6 students to Full Stack', r.status === 201 || r.status === 200, r.body);
  r = await http('POST', '/api/students/bulk', { token: T(lucky), body: { batch: B._id, rows: names.map((n, i) => ({ name: n + ' K', roll: `B20${i}` })) } });
  ok('trainer adds 6 students to BCA 1st', r.status === 201 || r.status === 200, r.body);
  const SA = await M('Student').find({ batch: A._id }).sort('roll'), SB = await M('Student').find({ batch: B._id }).sort('roll');

  // ═════════ PLANNING MEETING (Thu 31 Dec) ═════════
  step('Planning meeting: timetables + plan cycle 1 with a holiday');
  at('2026-12-31', '11:00');
  r = await http('POST', '/api/cycles/planner/preview', { token: T(admin), body: { groups: [{ batchIds: [A._id], start: '2027-01-04', end: '2027-01-15' }] } });
  ok('planner refuses a batch with no confirmed timetable', r.status === 200 && JSON.stringify(r.body).includes('timetable'), r.body);
  ok('admin saves Full Stack timetable Mon–Fri', (await http('PUT', `/api/settings/timetables/${A._id}`, { token: T(admin), body: { days: [1, 2, 3, 4, 5] } })).status === 200);
  ok('admin saves BCA 1st timetable Mon/Wed/Fri', (await http('PUT', `/api/settings/timetables/${B._id}`, { token: T(admin), body: { days: [1, 3, 5] } })).status === 200);
  const plan1 = { groups: [{ name: 'January', batchIds: [String(A._id), String(B._id)], start: '2027-01-04', end: '2027-01-15' }],
    holidays: [{ from: '2027-01-06', title: 'College event', batchIds: [] }] };
  r = await http('POST', '/api/cycles/planner/preview', { token: T(admin), body: plan1 });
  ok('preview has no errors', r.status === 200 && !(r.body.errors || []).length && (r.body.rows || []).every(x => !x.errors.length), r.body);
  r = await http('POST', '/api/cycles/planner', { token: T(admin), body: plan1 });
  ok('cycles created', r.status === 201, r.body);
  const cA = await M('Cycle').findOne({ batch: A._id, number: 1 }), cB = await M('Cycle').findOne({ batch: B._id, number: 1 });
  let pA = await M('CyclePlan').findOne({ cycle: cA._id }).lean(), pB = await M('CyclePlan').findOne({ cycle: cB._id }).lean();
  const datesA = pA.classes.map(k => k.date), datesB = pB.classes.map(k => k.date);
  ok('Full Stack: 9 dated class rows, holiday 6 Jan skipped', datesA.length === 9 && !datesA.includes('2027-01-06') && datesA[0] === '2027-01-04', datesA);
  ok('BCA 1st: 5 class rows (Mon/Wed/Fri minus holiday)', JSON.stringify(datesB) === JSON.stringify(['2027-01-04', '2027-01-08', '2027-01-11', '2027-01-13', '2027-01-15']), datesB);
  ok('project day = last class day, its row titled', perf.dayYmd(cA.track.projectDate) === '2027-01-15' && /project/i.test(pA.classes[8].title), pA.classes[8]);
  ok('cycles are tracked (scored) from creation', cA.track.tracked && cB.track.tracked);

  step('Trainers type topics; plan locks when complete');
  at('2027-01-01', '18:00');
  for (const k of pA.classes.filter(k => !k.title))
    ok(`Deepu fills class ${k.number}`, (await http('PATCH', `/api/cycleplans/${cA._id}/class/${k.number}`, { token: T(deepu), body: { title: 'MERN topic ' + k.number, notes: 'notes' } })).status === 200);
  for (const k of pB.classes.filter(k => !k.title))
    await http('PATCH', `/api/cycleplans/${cB._id}/class/${k.number}`, { token: T(lucky), body: { title: 'C topic ' + k.number } });
  r = await http('PATCH', `/api/cycleplans/${cA._id}/class/2`, { token: T(deepu), body: { title: 'changed my mind' } });
  ok('complete plan is locked for the trainer', r.status === 403 || r.status === 409, `${r.status}`);
  ok('Lucky cannot edit Deepu\'s plan', [403, 409].includes((await http('PATCH', `/api/cycleplans/${cA._id}/class/3`, { token: T(lucky), body: { title: 'x' } })).status));
  ok('admin opens editing for Full Stack', (await http('PATCH', '/api/cycleplans/board/open', { token: T(admin), body: { cycleId: cA._id, open: true } })).status === 200);
  ok('now Deepu can change class 2', (await http('PATCH', `/api/cycleplans/${cA._id}/class/2`, { token: T(deepu), body: { title: 'Express routing' } })).status === 200);
  r = await http('GET', '/api/cycleplans/board', { token: T(lucky) });
  ok('class plans board shows both batches to a trainer', r.status === 200 && r.body.cycles.length === 2, r.body?.cycles?.length);

  step('Students sign in with the batch code');
  const codeA = (await http('GET', `/api/student-admin/batch/${A._id}`, { token: T(deepu) })).body.joinCode;
  const codeB = (await http('GET', `/api/student-admin/batch/${B._id}`, { token: T(lucky) })).body.joinCode;
  ok('each batch has a join code', /^[A-Z0-9]{6}$/.test(codeA) && /^[A-Z0-9]{6}$/.test(codeB) && codeA !== codeB, `${codeA} ${codeB}`);
  ok('wrong code refused', (await http('POST', '/api/student/activate', { body: { roll: 'A100', code: codeB, password: 'secret12' } })).status === 400);
  for (const s of [...SA, ...SB]) {
    const rr = await http('POST', '/api/student/activate', { body: { roll: s.roll, code: String(s.batch) === String(A._id) ? codeA : codeB, password: 'secret12' } });
    if (rr.status !== 201) ok(`activate ${s.roll}`, false, rr.body);
  }
  ok('all 12 students set up (one sign-in each, on their main record)', (await M('Person').countDocuments({ 'login.activatedAt': { $ne: null } })) === 12);
  const stok = async (s) => (await http('POST', '/api/student/login', { body: { roll: s.roll, password: 'secret12' } })).body.token;

  // ═════════ CLASS DAYS ═════════
  const pulse = async (students, covered, u = 4) => { for (const s of students) await http('POST', '/api/student/pulse', { token: await stok(s), body: { covered, understanding: u } }); };
  const att = (S, absent = []) => S.map((s, i) => ({ student: s._id, present: !absent.includes(i) }));
  const log = (u, batch, date, extra = {}) => http('POST', '/api/logs', { token: T(u), body: { batch, date, status: 'done', github: 'most', attendance: att(batch === A._id ? SA : SB), ...extra } })
    .then(r => ({ ...r, status: r.status === 201 ? 200 : r.status }));   // 201 = created

  step('Mon 4 Jan — both batches: class, pulse, on-time logs');
  at('2027-01-04', '10:30');
  r = await http('GET', '/api/student/me', { token: await stok(SA[0]) });
  ok('student page shows today\'s class', r.body?.pulseToday?.title === 'MERN topic 1', r.body?.pulseToday);
  await pulse(SA, 'yes', 4); await pulse(SB, 'yes', 5);
  at('2027-01-04', '13:00');
  ok('Deepu logs class 1 same day', (await log(deepu, A._id, '2027-01-04', { attendance: att(SA, [5]) })).status === 200);
  ok('Lucky logs class 1 same day', (await log(lucky, B._id, '2027-01-04')).status === 200);
  const l1 = await M('DailyLog').findOne({ batch: A._id }).lean();
  ok('log linked to planned class 1 automatically', l1.planClass === 1, l1.planClass);

  step('Tue 5 Jan — Deepu forgets, logs next morning (late)');
  at('2027-01-05', '10:30'); await pulse(SA.slice(0, 4), 'yes');
  at('2027-01-06', '09:00');
  ok('late log for 5 Jan saved', (await log(deepu, A._id, '2027-01-05')).status === 200);

  step('Wed 6 Jan — holiday (planned): no class, pulse refused');
  at('2027-01-06', '11:00');
  r = await http('POST', '/api/student/pulse', { token: await stok(SA[0]), body: { covered: 'yes', understanding: 4 } });
  ok('pulse refused on a holiday', r.status === 400, r.body);
  r = await http('GET', '/api/student/me', { token: await stok(SB[0]) });
  ok('student page shows the holiday', JSON.stringify(r.body).includes('College event'));

  step('Thu 7 Jan — log says "done" but most students say not covered');
  at('2027-01-07', '10:30'); await pulse(SA.slice(0, 5), 'no', 2);
  at('2027-01-07', '13:00'); await log(deepu, A._id, '2027-01-07');
  at('2027-01-07', '17:00');
  r = await http('GET', '/api/meeting/day?date=2027-01-07', { token: T(admin) });
  const dayA = r.body.batches.find(b => b.batch === 'Full Stack');
  ok('daily review lists Full Stack with plan + log + pulse', !!dayA && dayA.planned[0]?.title && dayA.log?.status === 'done' && dayA.pulse?.responses === 5, dayA);
  ok('daily review flags the mismatch', dayA?.pulse?.mismatch === true, dayA?.pulse);
  ok('BCA 1st has no class Thu → not listed', !r.body.batches.some(b => b.batch === 'BCA 1st'));
  r = await http('POST', '/api/meeting/notes', { token: T(admin), body: { scope: 'day', date: '2027-01-07', batchId: String(A._id), text: 'Deepu: revisit topic 4 — students say not covered' } });
  ok('admin adds a meeting note for the batch', r.status === 201, r.body);
  ok('Deepu sees the note', ((await http('GET', '/api/meeting/day?date=2027-01-07', { token: T(deepu) })).body.notes || []).length === 1);
  ok('Lucky does not', ((await http('GET', '/api/meeting/day?date=2027-01-07', { token: T(lucky) })).body.notes || []).length === 0);

  step('Fri 8 Jan — Deepu does not log at all; Lucky logs');
  at('2027-01-08', '13:00'); await log(lucky, B._id, '2027-01-08');

  step('Mon 11 Jan — Deepu logs without GitHub (incomplete), fixes it next day');
  at('2027-01-11', '13:00');
  r = await log(deepu, A._id, '2027-01-11', { github: '' });
  ok('incomplete log saved (no GitHub)', r.status === 200);
  ok('…and marked as not complete', !(await M('DailyLog').findOne({ batch: A._id, date: perf.ymdToDay('2027-01-11') })).completeAt);
  await log(lucky, B._id, '2027-01-11');

  step('Mon 11 Jan evening — surprise holiday Tue 12 Jan for Full Stack (shift classes)');
  at('2027-01-11', '19:00');
  r = await http('POST', '/api/settings/holidays/preview', { token: T(admin), body: { from: '2027-01-12', title: 'Power cut', batchIds: [String(A._id)], mode: 'shift' } });
  ok('holiday preview ok', r.status === 200 && r.body.ok, r.body);
  r = await http('POST', '/api/settings/holidays', { token: T(admin), body: { from: '2027-01-12', title: 'Power cut', batchIds: [String(A._id)], mode: 'shift' } });
  ok('holiday applied', r.status === 201, r.body);
  const cA2 = await M('Cycle').findById(cA._id);
  pA = await M('CyclePlan').findOne({ cycle: cA._id }).lean();
  ok('classes moved: last class now Mon 18 Jan', pA.classes.map(k => k.date).at(-1) === '2027-01-18', pA.classes.map(k => k.date));
  ok('cycle end + project day moved to 18 Jan', perf.dayYmd(cA2.endDate) === '2027-01-18' && perf.dayYmd(cA2.track.projectDate) === '2027-01-18');
  ok('BCA 1st untouched', perf.dayYmd((await M('Cycle').findById(cB._id)).track.projectDate) === '2027-01-15');
  at('2027-01-12', '10:00'); await log(deepu, A._id, '2027-01-11', { github: 'all' });   // completes Monday's log a day late

  step('13–15 Jan — classes continue');
  for (const d of ['2027-01-13', '2027-01-14', '2027-01-15']) { at(d, '10:30'); await pulse(SA, 'yes'); at(d, '13:00'); await log(deepu, A._id, d); }
  at('2027-01-13', '13:00'); await log(lucky, B._id, '2027-01-13');

  // ═════════ PROJECT DAY — BCA 1st (Fri 15 Jan) ═════════
  step('Project day BCA 1st: submissions, feedback, marks');
  at('2027-01-15', '09:30');
  r = await http('POST', '/api/student/submission', { token: await stok(SB[0]), body: { cycleId: cB._id, githubUrl: 'https://github.com/b/p' } });
  ok('submission closed until the trainer opens it', r.status === 400);
  ok('Lucky opens submission for 2 hours', (await http('POST', `/api/student-admin/cycle/${cB._id}/submission`, { token: T(lucky), body: { open: true, minutes: 120 } })).status === 200);
  at('2027-01-15', '10:30');
  for (const s of SB.slice(0, 5)) ok(`${s.roll} submits`, (await http('POST', '/api/student/submission', { token: await stok(s), body: { cycleId: cB._id, githubUrl: `https://github.com/${s.roll}/c-project` } })).status === 201);
  at('2027-01-15', '13:00');
  ok('after 2 hours it is closed again', (await http('POST', '/api/student/submission', { token: await stok(SB[5]), body: { cycleId: cB._id, githubUrl: 'https://github.com/x/y' } })).status === 400);
  r = await http('POST', '/api/feedback/windows', { token: T(admin), body: { title: 'Cycle 1 feedback', batchIds: [String(B._id)], hours: 48 } });
  ok('admin opens the feedback form', r.status === 201);
  const wid = r.body.window._id;
  const rat = { clarity: 4, punctuality: 5, help: 4, practical: 3, overall: 4 };
  for (const s of SB.slice(0, 4)) await http('POST', '/api/student/feedback', { token: await stok(s), body: { windowId: wid, trainerId: lucky._id, ratings: rat } });
  r = await http('GET', `/api/feedback/windows/${wid}/results`, { token: T(lucky) });
  ok('trainer cannot see averages with only 4 answers', r.body.rows[0].averages == null, r.body.rows[0]);
  await http('POST', '/api/student/feedback', { token: await stok(SB[4]), body: { windowId: wid, trainerId: lucky._id, ratings: rat, comment: 'good' } });
  r = await http('GET', `/api/feedback/windows/${wid}/results`, { token: T(lucky) });
  ok('5 answers → trainer sees averages, no names', r.body.rows[0].averages?.overall === 4 && !JSON.stringify(r.body).includes('Aman'), r.body.rows[0]);

  const hof = async () => (await http('GET', '/api/cycles/halloffame')).body;
  const hofFor = (h, name) => h.cycles.find(c => c.batch?.name === name);
  at('2027-01-15', '17:00'); await log(lucky, B._id, '2027-01-15');   // project-day class is logged too
  at('2027-01-15', '18:00');
  const marksB = [[95, 90], [80, 85], [95, 90], [60, 70], [40, 50], null];   // B201 ties B200; B205 absent
  const rowsB = SB.map((s, i) => marksB[i] ? { student: s._id, status: 'evaluated', assessment: marksB[i][0], project: marksB[i][1] } : { student: s._id, status: 'not-evaluated' });
  ok('Lucky saves marks for 3 students', (await http('PUT', `/api/marks/${cB._id}`, { token: T(lucky), body: { rows: rowsB.slice(0, 3) } })).status === 200);
  ok('Hall of Fame: nothing for BCA 1st while marks are incomplete', !hofFor(await hof(), 'BCA 1st'));
  ok('Lucky saves the rest', (await http('PUT', `/api/marks/${cB._id}`, { token: T(lucky), body: { rows: rowsB.slice(3) } })).status === 200);
  let h = await hof();
  const hb = hofFor(h, 'BCA 1st');
  ok('Hall of Fame shows BCA 1st cycle 1 automatically once marks are complete', !!hb && hb.number === 1, h.cycles.map(c => c.batch?.name));
  ok('Top 3 = highest totals (tie broken the same way every time)', hb && hb.top3.map(t => t.roll).join(',') === 'B200,B202,B201', hb?.top3);
  ok('Top 3 carries each topper\'s project link', hb && hb.top3[0].github === 'https://github.com/B200/c-project', hb?.top3?.[0]);
  ok('Top 3 counts as done for Lucky (on time)', !!(await M('Cycle').findById(cB._id)).track.top3?.at);

  step('Report: trainer fills it after project day — no admin step needed');
  at('2027-01-16', '11:00');
  r = await http('PUT', `/api/cycles/${cB._id}/report`, { token: T(lucky), body: { problemsFaced: 'none', performanceRating: 4, projectTitle: 'Calculator in C' } });
  ok('trainer can save the report after project day', r.status === 200, r.body);
  r = await http('PUT', `/api/cycles/${cA._id}/report`, { token: T(deepu), body: { problemsFaced: 'too early' } });
  ok('…but not before their own project day', r.status === 400, r.body);

  step('Trainer overrides the Top 3 (e.g. a better project)');
  const cur = (await http('GET', `/api/cycles/${cB._id}`, { token: T(lucky) })).body.cycle.report.top3;
  const swapped = [cur[1], cur[0], cur[2]].map((t, i) => ({ ...t, rank: i + 1 }));
  ok('override saved', (await http('PUT', `/api/cycles/${cB._id}/report`, { token: T(lucky), body: { top3: swapped } })).status === 200);
  ok('Hall of Fame shows the trainer\'s order', hofFor(await hof(), 'BCA 1st').top3[0].roll === 'B202');
  await http('PUT', `/api/marks/${cB._id}`, { token: T(lucky), body: { rows: [rowsB[3]] } });
  ok('a later marks save does not undo the manual Top 3', hofFor(await hof(), 'BCA 1st').top3[0].roll === 'B202');
  ok('"Back to automatic" restores the Top 3 from marks', (await http('PUT', `/api/cycles/${cB._id}/report`, { token: T(lucky), body: { top3Auto: true } })).status === 200
    && hofFor(await hof(), 'BCA 1st').top3.map(t => t.roll).join(',') === 'B200,B202,B201');
  ok('…keeping the photo/link already added', hofFor(await hof(), 'BCA 1st').top3[0].github === 'https://github.com/B200/c-project');

  step('Demo student (e.g. for the MD): can use everything, counts nowhere');
  r = await http('POST', '/api/students/bulk', { token: T(lucky), body: { batch: B._id, rows: [{ name: 'MD Demo', roll: 'MDDEMO1' }] } });
  const demo = await M('Student').findOne({ roll: 'MDDEMO1' });
  ok('admin marks it as a demo account', (await http('PUT', `/api/students/${demo._id}`, { token: T(admin), body: { demo: true } })).status === 200);
  ok('a trainer cannot', (await http('PUT', `/api/students/${demo._id}`, { token: T(lucky), body: { demo: false } })).status === 200 && (await M('Student').findById(demo._id)).demo === true);
  ok('demo student sets up with the batch code', (await http('POST', '/api/student/activate', { body: { roll: 'MDDEMO1', code: codeB, password: 'secret12' } })).status === 201);
  const dtok = await stok(demo);
  r = await http('GET', '/api/student/me', { token: dtok });
  ok('demo dashboard opens, flagged as demo', r.status === 200 && r.body.student.demo === true);
  r = await http('POST', '/api/student/feedback', { token: dtok, body: { windowId: wid, trainerId: lucky._id, ratings: rat } });
  ok('demo feedback is not saved', r.body?.demo === true && (await M('Feedback').Feedback?.countDocuments?.({ student: demo._id }) ?? 0) === 0);
  ok('not in the roster', !((await http('GET', `/api/students?batch=${B._id}`, { token: T(lucky) })).body.students || []).some(x => x.roll === 'MDDEMO1'));
  ok('not on the marks sheet', !((await http('GET', `/api/marks/${cB._id}`, { token: T(lucky) })).body.rows || []).some(x => x.roll === 'MDDEMO1'));
  ok('marks still count as complete (Top 3 not blocked)', await perf.marksComplete(await M('Cycle').findById(cB._id)));
  r = await http('GET', `/api/student-admin/batch/${B._id}`, { token: T(lucky) });
  ok('Student login tab lists it, marked demo, not in the totals', r.body.students.some(x => x.roll === 'MDDEMO1' && x.demo) && r.body.total === 6, r.body.total);

  step('Student profile photo → Hall of Fame');
  // four tiny real JPEGs (24×24, different colours)
  const JPG = ["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"];
  const jpg = (n) => 'data:image/jpeg;base64,' + JPG[n - 1];
  ok('junk bytes labelled as JPEG refused', (await http('PUT', '/api/student/photo', { token: await stok(SB[0]), body: { photo: 'data:image/jpeg;base64,' + Buffer.alloc(100, 7).toString('base64') } })).status === 400);
  const topTok = await stok(SB[0]);
  ok('bad file type refused', (await http('PUT', '/api/student/photo', { token: topTok, body: { photo: 'data:text/html;base64,PGI+' } })).status === 400);
  ok('too large refused', (await http('PUT', '/api/student/photo', { token: topTok, body: { photo: 'data:image/jpeg;base64,' + Buffer.alloc(500 * 1024, 1).toString('base64') } })).status === 400);
  r = await http('PUT', '/api/student/photo', { token: topTok, body: { photo: jpg(1) } });
  ok('topper sets a profile photo — Hall of Fame updated', r.status === 200 && r.body.hasPhoto && r.body.hallOfFame === 1, r.body);
  const photoOf = async () => { const u = hofFor(await hof(), 'BCA 1st').top3[0].photo; if (!u) return null; const res = await fetch(base + '/api' + u); if (!res.ok) return null; const b = Buffer.from(await res.arrayBuffer()).toString('base64'); return JPG.indexOf(b) + 1; };
  const url1 = hofFor(await hof(), 'BCA 1st').top3[0].photo;
  ok('Hall of Fame serves the student\'s photo', (await photoOf()) === 1, url1);
  r = await http('GET', '/api/student/me', { token: topTok });
  ok('dashboard shows the photo and the Top 3 finish', r.body.student.photo?.startsWith('data:image/jpeg') && r.body.achievements.some(a => a.cycle === 1 && a.rank === 1), r.body.achievements);
  at('2027-01-16', '11:05');
  await http('PUT', '/api/student/photo', { token: topTok, body: { photo: jpg(2) } });
  const url2 = hofFor(await hof(), 'BCA 1st').top3[0].photo;
  ok('changed photo → new image, new URL (no stale browser copy)', (await photoOf()) === 2 && url2 !== url1, `${url1} → ${url2}`);
  ok('a student not in the Top 3 sets a photo — nothing on the board changes', (await http('PUT', '/api/student/photo', { token: await stok(SB[5]), body: { photo: jpg(3) } })).body.hallOfFame === 0);
  r = await http('GET', `/api/student-admin/batch/${B._id}`, { token: T(lucky) });
  ok('trainer sees who has a photo', r.body.students.filter(x => x.hasPhoto).length === 2);
  ok('trainer removes a photo', (await http('PUT', `/api/students/${SB[0]._id}`, { token: T(lucky), body: { photo: null } })).status === 200);
  ok('…and it is gone from the Hall of Fame', !hofFor(await hof(), 'BCA 1st').top3[0].photo);
  await http('PUT', '/api/student/photo', { token: topTok, body: { photo: jpg(4) } });

  // ═════════ PROJECT DAY — Full Stack (Mon 18 Jan, moved by the holiday) ═════════
  step('Project day Full Stack (moved to Mon 18 Jan)');
  at('2027-01-18', '10:00');
  r = await http('GET', '/api/student/me', { token: await stok(SA[0]) });
  ok('student sees project day 18 Jan', r.body?.project?.projectDay === '2027-01-18', r.body?.project);
  await http('POST', `/api/student-admin/cycle/${cA._id}/submission`, { token: T(deepu), body: { open: true } });
  for (const s of SA) await http('POST', '/api/student/submission', { token: await stok(s), body: { cycleId: cA._id, githubUrl: `https://github.com/${s.roll}/mern`, liveUrl: 'https://x.vercel.app' } });
  r = await http('GET', `/api/student-admin/cycle/${cA._id}/submissions`, { token: T(deepu) });
  ok('Deepu sees 6 submissions', (r.body.submissions || r.body.rows || []).length === 6, r.body);
  at('2027-01-18', '13:00'); await log(deepu, A._id, '2027-01-18');
  at('2027-01-19', '17:00');
  const marksA = [[70, 75], [88, 92], [55, 60], [90, 95], [0, 0], [65, 70]];
  ok('Deepu saves all marks', (await http('PUT', `/api/marks/${cA._id}`, { token: T(deepu), body: { rows: SA.map((s, i) => ({ student: s._id, status: 'evaluated', assessment: marksA[i][0], project: marksA[i][1] })) } })).status === 200);
  h = await hof();
  ok('Hall of Fame now shows both batches', hofFor(h, 'Full Stack')?.top3.map(t => t.roll).join(',') === 'A103,A101,A100', hofFor(h, 'Full Stack')?.top3);
  ok('a student with 0 marks is never in the Top 3', !hofFor(h, 'Full Stack').top3.some(t => t.roll === 'A104'));
  at('2027-01-20', '12:00');
  ok('Deepu fills his report', (await http('PUT', `/api/cycles/${cA._id}/report`, { token: T(deepu), body: { problemsFaced: 'power cut', performanceRating: 3 } })).status === 200);

  step('Class health: one view of every class, with filters');
  at('2027-01-21', '10:00');
  r = await http('GET', `/api/meeting/health?from=2027-01-04&to=2027-01-18&batches=${A._id}`, { token: T(admin) });
  const hA = r.body.batches?.[0];
  const st = (d) => hA.classes.find(c => c.date === d);
  ok('only the filtered batch', r.status === 200 && r.body.batches.length === 1 && hA.batch === 'Full Stack', r.body);
  ok('4 Jan: done, on time, attendance 5/6', st('2027-01-04').state === 'done' && st('2027-01-04').log.onTime && st('2027-01-04').attendance.present === 5, st('2027-01-04'));
  ok('5 Jan: late log flagged', st('2027-01-05').flags.includes('late log'));
  ok('6 + 12 Jan: holidays', st('2027-01-06')?.state === 'holiday' && st('2027-01-12')?.state === 'holiday', hA.classes.map(c => c.date + ':' + c.state));
  ok('7 Jan: students disagree flagged', st('2027-01-07').flags.includes('students disagree'));
  ok('8 Jan: not logged', st('2027-01-08').state === 'missing' && st('2027-01-08').flags.includes('not logged'));
  ok('11 Jan: completed the next day = late', st('2027-01-11').flags.includes('late log') && st('2027-01-11').log.complete);
  ok('summary counts', hA.summary.missing === 1 && hA.summary.disagree === 1 && hA.summary.holidays === 2 && hA.summary.answers > 0, hA.summary);
  r = await http('GET', `/api/meeting/health?from=2027-01-04&to=2027-01-18&trainer=${deepu._id}`, { token: T(admin) });
  ok('trainer filter: only Deepu\'s batch', r.body.batches.length === 1 && r.body.batches[0].batch === 'Full Stack');
  r = await http('GET', '/api/meeting/health?from=2027-01-04&to=2027-01-18', { token: T(admin) });
  ok('admin sees every batch', r.body.batches.length === 2 && r.body.seesAll === true);
  r = await http('GET', `/api/meeting/health?from=2027-01-04&to=2027-01-18&trainer=${deepu._id}`, { token: T(lucky) });
  ok('a trainer sees only own batches (even asking for another trainer\'s)', r.body.batches.length === 1 && r.body.batches[0].batch === 'BCA 1st' && r.body.batches[0].mine && r.body.seesAll === false, r.body.batches);
  r = await http('GET', `/api/meeting/health?from=2027-01-04&to=2027-01-18&batches=${A._id}`, { token: T(lucky) });
  ok('…and not another batch by id', r.body.batches.length === 0);
  ok('cycle periods offered as quick picks', r.body.periods.length >= 1 && r.body.periods[0].start === '2027-01-04', r.body.periods);
  ok('over 120 days refused', (await http('GET', '/api/meeting/health?from=2027-01-01&to=2027-06-30', { token: T(lucky) })).status === 400);

  step('Performance + cycle review meeting');
  at('2027-01-21', '11:00');
  r = await http('GET', '/api/performance', { token: T(admin) });
  ok('performance page loads', r.status === 200 && r.body.rows.length >= 1, r.body);
  const allRows = [];
  for (const p of r.body.periods) allRows.push(...(await http('GET', `/api/performance?period=${p.key}`, { token: T(admin) })).body.rows);
  const pfA = allRows.find(x => x.batch === 'Full Stack'), pfB = allRows.find(x => x.batch === 'BCA 1st');
  ok('BCA 1st: plan, logs, marks, Top 3, report all on time', pfB && ['plan', 'marks', 'top3', 'report'].every(k => pfB.items[k].state === 'on-time') && pfB.items.logs.onTime === pfB.items.logs.days, pfB?.items);
  ok('Full Stack logs: late, incomplete-then-late, missing counted', pfA && pfA.items.logs.late >= 2 && pfA.items.logs.missing === 1, pfA?.items?.logs);
  ok('holidays never become class days (9 class days: 6 & 12 Jan left out)', pfA && pfA.items.logs.days === 9, pfA?.items?.logs);
  ok('Lucky scores higher than Deepu', pfA && pfB && pfB.score > pfA.score, `${pfB?.score} vs ${pfA?.score}`);
  const tr = (await http('GET', '/api/performance', { token: T(admin) })).body.trainers;
  const tD = tr.find(x => x.name === 'Deepu');
  ok('trainer pop-up data: history per cycle + warning signs', tD && tD.history.length >= 1 && tD.history[0].items.logs && tD.signs.logsMissing === 1 && tD.signs.logsLate >= 2, JSON.stringify(tD && { h: tD.history.length, s: tD.signs }));
  r = await http('GET', `/api/meeting/review?period=${r.body.periods[0].key}`, { token: T(admin) });
  ok('cycle review lists trainers with facts', r.status === 200 && r.body.trainers.length >= 1, r.body);
  const all = [];
  for (const p of (await http('GET', '/api/performance', { token: T(admin) })).body.periods) all.push(...(await http('GET', `/api/meeting/review?period=${p.key}`, { token: T(admin) })).body.trainers.flatMap(t => t.batches));
  const rvB = all.find(x => x.batch === 'BCA 1st');
  ok('review: BCA 1st submissions 5/6, marks evaluated 5, feedback 5 answers, pulse days', rvB && rvB.submissions.submitted === 5 && rvB.marks.evaluated === 5 && rvB.feedback?.responses === 5 && rvB.pulse.days >= 1, rvB);

  step('Admin closes the cycles; students see their results');
  at('2027-01-22', '10:00');
  ok('close Full Stack cycle 1', (await http('POST', `/api/cycles/${cA._id}/close`, { token: T(admin) })).status === 200);
  ok('close BCA 1st cycle 1', (await http('POST', `/api/cycles/${cB._id}/close`, { token: T(admin) })).status === 200);
  ok('closed cycle report is frozen', (await http('PUT', `/api/cycles/${cA._id}/report`, { token: T(deepu), body: { reflection: 'x' } })).status === 400);
  r = await http('GET', '/api/student/me', { token: await stok(SA[3]) });
  ok('student sees cycle 1 marks on their page', JSON.stringify(r.body?.history || r.body?.marks || '').includes('185'), r.body?.history || r.body?.marks);
  r = await http('GET', '/api/students/top', { token: T(admin) });
  const divya = (r.body.students || []).find(s => s.roll === 'A103');
  ok('top students: Top 3 finish counted for the topper', divya?.top3 === 1, divya);
  ok('top students: submitted project counted', divya?.projectsSubmitted === 1 && divya?.projectsDue === 1, divya);
  ok('top students: topper is labelled Good or Excellent', !!divya?.tier && divya.score >= 65, divya);
  r = await http('GET', '/api/students/top', { token: T(deepu) });
  ok('top students: a trainer sees only own batches', r.body.students.length > 0 && r.body.students.every(s => s.batch.name === 'Full Stack'), r.body.batches);
  r = await http('GET', `/api/toppers?batch=${A._id}`, { token: T(deepu) });
  ok('batch Toppers tab shows the cycle Top 3', JSON.stringify(r.body).includes('A103'), r.body);

  // ═════════ NEXT CYCLE ═════════
  step('Next planning meeting: cycle 2; Hall of Fame keeps cycle 1 until cycle 2 marks are done');
  at('2027-01-22', '12:00');
  const plan2 = { groups: [{ name: 'Feb', batchIds: [String(A._id), String(B._id)], start: '2027-01-25', end: '2027-02-05' }] };
  r = await http('POST', '/api/cycles/planner', { token: T(admin), body: plan2 });
  ok('cycle 2 created for both', r.status === 201, r.body);
  const cA_2 = await M('Cycle').findOne({ batch: A._id, number: 2 }), cB_2 = await M('Cycle').findOne({ batch: B._id, number: 2 });
  const pA_2 = await M('CyclePlan').findOne({ cycle: cA_2._id }).lean();
  ok('class numbers continue (Full Stack starts at 10)', pA_2.classes[0].number === 10, pA_2.classes[0]);
  ok('Hall of Fame still shows cycle 1', hofFor(await hof(), 'BCA 1st').number === 1);
  at('2027-02-05', '18:00');
  await http('PUT', `/api/marks/${cB_2._id}`, { token: T(lucky), body: { rows: SB.map((s, i) => ({ student: s._id, status: 'evaluated', assessment: 50 + i * 5, project: 50 + i * 5 })) } });
  h = await hof();
  ok('BCA 1st moves to cycle 2 on the Hall of Fame', hofFor(h, 'BCA 1st').number === 2 && hofFor(h, 'BCA 1st').top3[0].roll === 'B205', hofFor(h, 'BCA 1st'));
  ok('Full Stack stays on cycle 1 (its cycle 2 marks not in)', hofFor(h, 'Full Stack').number === 1);
  r = await http('GET', `/api/cycles/halloffame?semester=${sem._id}`);
  ok('one entry per batch', r.body.cycles.length === 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log('Failed:\n  ' + fails.join('\n  '));
  clock.uninstall(); server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
