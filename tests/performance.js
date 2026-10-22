// Trainer Performance (accountability) test — real Express routes against a
// throwaway MongoDB. Never touches Atlas.
//
//   npm run test:performance
process.env.JWT_SECRET = 'test-secret';

const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');

const User = require('../models/User'), Semester = require('../models/Semester'), Batch = require('../models/Batch');
const Student = require('../models/Student'), Cycle = require('../models/Cycle'), CycleMark = require('../models/CycleMark');
const DailyLog = require('../models/DailyLog');
const perf = require('../services/performance');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x); } };

let base;
const http = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const DAY = 864e5;
const day = (offset) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
const ymd = (d) => perf.dayYmd(d);

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
  }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();

  const app = express(); app.use(express.json({ limit: '5mb' }));
  app.use('/api/cycles', require('../routes/cycles'));
  app.use('/api/marks', require('../routes/cyclemarks'));
  app.use('/api/logs', require('../routes/logs'));
  app.use('/api/cycleplans', require('../routes/cycleplans'));
  app.use('/api/performance', require('../routes/performance'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const admin  = await User.create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const samant = await User.create({ name: 'Mr Samant', email: 's@x.com', password: 'longpassword1', role: 'trainer' });
  const deepu  = await User.create({ name: 'Deepu', email: 'd@x.com', password: 'longpassword1', role: 'trainer' });
  const md     = await User.create({ name: 'MD (Review)', email: 'md@x.com', password: 'longpassword1', role: 'trainer' });
  const sem = await Semester.create({ name: 'Odd 2026', status: 'active' });
  const mern = await Batch.create({ name: 'Full Stack', track: 'MERN', semester: sem._id, trainers: [samant._id, md._id] });
  const bca  = await Batch.create({ name: 'BCA 3 A', semester: sem._id, trainers: [deepu._id] });
  const S = [];
  for (const [r, n] of [['101', 'Aman'], ['102', 'Bhavna'], ['103', 'Chetan']])
    S.push(await Student.create({ name: n, roll: r, batch: mern._id, semester: sem._id }));
  const B = await Student.create({ name: 'Zoya', roll: '201', batch: bca._id, semester: sem._id });
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);

  console.log('\n— default deadline (Saturday after project day, 7 PM IST)');
  const dl = (s) => new Date(perf.defaultDeadline(perf.ymdToDay(s)).getTime() + 330 * 60000).toISOString().slice(0, 16);
  ok('project Thu 15 Oct → Sat 17 Oct 19:00', dl('2026-10-15') === '2026-10-17T19:00', dl('2026-10-15'));
  ok('project Wed 14 Oct → Sat 17 Oct 19:00', dl('2026-10-14') === '2026-10-17T19:00', dl('2026-10-14'));
  ok('project on a Saturday → next Saturday', dl('2026-10-17') === '2026-10-24T19:00', dl('2026-10-17'));
  ok('IST deadline input parsed', perf.istToDate('2026-10-17T19:00').toISOString() === '2026-10-17T13:30:00.000Z');

  console.log('\n— new cycles are tracked, old ones are not');
  const old = await Cycle.create({ batch: mern._id, semester: sem._id, number: 3, startDate: day(-40), endDate: day(-30) });
  ok('existing cycle defaults to untracked', old.track.tracked === false);
  const created = await http('POST', '/api/cycles', { token: T(admin), body: { batch: mern._id, number: 4, startDate: ymd(day(-10)), endDate: ymd(day(-3)) } });
  ok('cycle created via website is tracked', created.status === 201 && created.body.cycle.track.tracked === true, JSON.stringify(created.body).slice(0, 200));
  const c4 = await Cycle.findById(created.body.cycle._id);
  const bulk = await http('POST', '/api/cycles/bulk', { token: T(admin), body: { batches: [bca._id], startDate: ymd(day(-10)), endDate: ymd(day(-3)) } });
  await Cycle.updateOne({ _id: bulk.body.created[0].cycleId }, { $set: { number: 4 } }); // same round as Full Stack
  const b4 = await Cycle.findById(bulk.body.created[0].cycleId);
  ok('bulk-created cycle is tracked', b4.track.tracked === true);

  console.log('\n— stamps: who did it, admin or trainer');
  // Samant plans late (cycle already started), Deepu's plan is filled by admin
  let r = await http('PUT', `/api/cycleplans/${c4._id}`, { token: T(samant), body: { classes: [{ title: 'Hooks', date: ymd(day(-9)) }, { title: 'Routing', date: ymd(day(-8)) }] } });
  ok('trainer saves cycle plan', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  r = await http('PUT', `/api/cycleplans/${b4._id}`, { token: T(admin), body: { classes: [{ title: 'Loops', date: ymd(day(-9)) }] } });
  let c = await Cycle.findById(c4._id), b = await Cycle.findById(b4._id);
  ok('plan stamp by trainer (admin=false)', c.track.plan?.at && c.track.plan.admin === false && String(c.track.plan.by) === String(samant._id));
  ok('plan stamp by admin (admin=true)', b.track.plan?.at && b.track.plan.admin === true);

  // marks: only partial first → no stamp; complete → stamp
  await http('POST', `/api/cycles/${c4._id}/open`, { token: T(admin) });
  await http('POST', `/api/cycles/${b4._id}/open`, { token: T(admin) });
  r = await http('PUT', `/api/marks/${c4._id}`, { token: T(samant), body: { rows: [{ student: S[0]._id, status: 'evaluated', assessment: 90, project: 90 }] } });
  c = await Cycle.findById(c4._id);
  ok('partial marks do not count as done', r.status === 200 && !c.track.marks?.at, JSON.stringify(r.body));
  await http('PUT', `/api/marks/${c4._id}`, { token: T(samant), body: { rows: [
    { student: S[1]._id, status: 'evaluated', assessment: 30, project: 30 }, { student: S[2]._id, status: 'not-evaluated' }] } });
  c = await Cycle.findById(c4._id);
  ok('complete marks are stamped by the trainer', c.track.marks?.at && c.track.marks.admin === false);
  await http('PUT', `/api/marks/${b4._id}`, { token: T(admin), body: { rows: [{ student: B._id, status: 'evaluated', assessment: 80, project: 80 }] } });
  b = await Cycle.findById(b4._id);
  ok('marks filled by admin are stamped admin=true', b.track.marks?.admin === true);

  // report + Top 3
  await http('PUT', `/api/cycles/${c4._id}/report`, { token: T(samant), body: { problemsFaced: 'none', performanceRating: 4 } });
  c = await Cycle.findById(c4._id);
  ok('report stamped, Top 3 not yet', c.track.report?.at && !c.track.top3?.at);
  await http('PUT', `/api/cycles/${c4._id}/report`, { token: T(samant), body: { top3: [{ rank: 1, student: S[0]._id, name: 'Aman', roll: '101' }] } });
  c = await Cycle.findById(c4._id);
  ok('Top 3 stamped', c.track.top3?.at && c.track.top3.admin === false);
  const firstAt = +c.track.report.at;
  await http('PUT', `/api/cycles/${c4._id}/report`, { token: T(samant), body: { reflection: 'edit' } });
  c = await Cycle.findById(c4._id);
  ok('first completion time never changes', +c.track.report.at === firstAt);

  console.log('\n— daily logs: first logger is remembered');
  await http('POST', '/api/logs', { token: T(admin), body: { batch: mern._id, date: ymd(day(-8)), notes: 'admin log' } });
  await http('POST', '/api/logs', { token: T(samant), body: { batch: mern._id, date: ymd(day(-8)), notes: 'samant edits' } });
  const lg = await DailyLog.findOne({ batch: mern._id, date: day(-8) });
  ok('firstLoggedBy stays admin after trainer edits', lg && String(lg.firstLoggedBy) === String(admin._id) && String(lg.loggedBy) === String(samant._id),
    JSON.stringify(lg && { f: lg.firstLoggedBy, l: lg.loggedBy }));
  // Samant logs day -9 on the same day (simulate: createdAt = that day midday IST)
  await http('POST', '/api/logs', { token: T(samant), body: { batch: mern._id, date: ymd(day(-9)), notes: 'hooks', attendance: [{ student: S[0]._id, present: true }] } });
  await DailyLog.collection.updateOne({ batch: mern._id, date: day(-9) }, { $set: { createdAt: new Date(day(-9).getTime() + 6 * 3600e3) } });

  console.log('\n— scoring');
  // Deadline in the past for both; Samant completed AFTER it (late by ~1 day), Deepu's by admin
  const deadline = new Date(Date.now() - 1 * DAY);
  await Cycle.updateOne({ _id: c4._id }, { $set: { 'track.deadline': deadline } });
  await Cycle.updateOne({ _id: b4._id }, { $set: { 'track.deadline': deadline } });
  c = await Cycle.findById(c4._id);
  let s = await perf.scoreCycle(c);
  ok('Samant: report late (half points)', s.items.report.state === 'late' && s.items.report.points === 5, JSON.stringify(s.items.report));
  ok('Samant: Top 3 late', s.items.top3.state === 'late');
  ok('overall = late with late-by days', s.overall === 'late' && s.lateBy > 0, s.overall + ' ' + s.lateBy);
  ok('plan made after start = late', s.items.plan.state === 'late', JSON.stringify(s.items.plan));
  ok('logs: 2 class days (1 on time by trainer, 1 by admin)', s.items.logs.days === 2 && s.items.logs.onTime === 1 && s.items.logs.admin === 1, JSON.stringify(s.items.logs));
  ok('attendance only counts trainer days with roll call', s.items.attendance.taken === 1);
  ok('outcomes: 1 of 2 evaluated at Moderate+', s.items.outcomes.good === 1 && s.items.outcomes.evaluated === 2, JSON.stringify(s.items.outcomes));
  ok('score is a number 0–100', Number.isInteger(s.score) && s.score > 0 && s.score < 100, s.score);

  b = await Cycle.findById(b4._id);
  const sb = await perf.scoreCycle(b);
  ok('Deepu: marks by admin → admin, 0 points', sb.items.marks.state === 'admin' && sb.items.marks.points === 0);
  ok('Deepu: report never filled → missing', sb.items.report.state === 'missing');
  ok('Deepu overall = missing', sb.overall === 'missing');

  // on time when completed before deadline
  await Cycle.updateOne({ _id: c4._id }, { $set: { 'track.deadline': new Date(Date.now() + DAY) } });
  s = await perf.scoreCycle(await Cycle.findById(c4._id));
  ok('same work before deadline → on time, full points', s.overall === 'on-time' && s.items.report.points === 10);

  // excused
  await Cycle.updateOne({ _id: c4._id }, { $set: { 'track.deadline': deadline, 'track.excusedNote': 'Exam duty' } });
  s = await perf.scoreCycle(await Cycle.findById(c4._id));
  ok('excused cycle: late items get full points', s.items.report.state === 'excused' && s.items.report.points === 10);
  await Cycle.updateOne({ _id: c4._id }, { $set: { 'track.excusedNote': '' } });

  // pending before deadline
  const fut = await Cycle.create({ batch: bca._id, semester: sem._id, number: 5, startDate: day(2), endDate: day(10), track: { tracked: true } });
  s = await perf.scoreCycle(fut);
  ok('future cycle: everything pending, no score', s.overall === 'pending' && s.score === null, JSON.stringify({ o: s.overall, sc: s.score }));

  console.log('\n— API');
  const d = await http('GET', '/api/performance?number=4', { token: T(deepu) });
  ok('any trainer can read the dashboard', d.status === 200 && d.body.rows.length === 2, JSON.stringify(d.body).slice(0, 300));
  const row = d.body.rows.find(x => x.batch === 'Full Stack');
  ok('row shows who did each item', row.who.report.by === 'Mr Samant' && row.who.report.admin === false);
  ok('reviewer account not listed as trainer', !row.trainers.some(t => /review/i.test(t.name)));
  ok('trainer table has Samant and Deepu, not MD', d.body.trainers.length === 2 && !d.body.trainers.some(t => /review/i.test(t.name)), JSON.stringify(d.body.trainers));
  ok('periods list includes untracked cycle 3', d.body.periods.some(x => x.numbers.includes(3) && !x.tracked), JSON.stringify(d.body.periods));
  const d3 = await http('GET', '/api/performance?number=3', { token: T(deepu) });
  ok('untracked cycle has no score', d3.body.rows[0].score === null && d3.body.rows[0].tracked === false);

  r = await http('PATCH', `/api/performance/cycle/${c4._id}`, { token: T(samant), body: { excusedNote: 'me' } });
  ok('trainer cannot change deadlines/excuses', r.status === 403, r.status);
  r = await http('PATCH', `/api/performance/cycle/${c4._id}`, { token: T(admin), body: { projectDate: '2026-10-15', deadline: '' } });
  c = await Cycle.findById(c4._id);
  ok('admin sets project day; deadline falls back to default', r.status === 200 && ymd(c.track.projectDate) === '2026-10-15' && !c.track.deadline
    && new Date(r.body.deadline).toISOString() === '2026-10-17T13:30:00.000Z', JSON.stringify(r.body));
  r = await http('PATCH', `/api/performance/cycle/${c4._id}`, { token: T(admin), body: { deadline: 'nonsense' } });
  ok('bad deadline rejected', r.status === 400);
  // backfilling who/when for a past cycle
  r = await http('PATCH', `/api/performance/cycle/${old._id}`, { token: T(admin), body: {
    tracked: true, projectDate: '2026-10-15', deadline: '2026-10-17T21:00',
    stamps: { report: { at: '2026-10-20T18:00', by: String(samant._id), admin: false }, marks: { at: '2026-10-19T10:00', by: String(admin._id), admin: true },
      top3: { at: '2026-10-17T20:00', by: String(samant._id), admin: false } } } });
  let o = await Cycle.findById(old._id); const so = await perf.scoreCycle(o);
  ok('backfilled report is late by ~3 days', r.status === 200 && so.items.report.state === 'late' && Math.round(so.items.report.lateDays) === 3, JSON.stringify(so.items.report));
  ok('backfilled marks show done by admin', so.items.marks.state === 'admin');
  ok('backfilled Top 3 on time (before 9 PM deadline)', so.items.top3.state === 'on-time');
  r = await http('PATCH', `/api/performance/cycle/${old._id}`, { token: T(admin), body: { stamps: { top3: null } } });
  o = await Cycle.findById(old._id);
  ok('a backfilled record can be cleared', !o.track.top3?.at);
  r = await http('PATCH', `/api/performance/cycle/${old._id}`, { token: T(admin), body: { stamps: { report: { at: 'yesterday' } } } });
  ok('bad backfill time rejected', r.status === 400);
  await User.updateOne({ _id: deepu._id }, { isActive: false });
  const di = await http('GET', '/api/performance?number=4', { token: T(admin) });
  ok('inactive trainer left out of scores and batch rows', !di.body.trainers.some(t => t.name === 'Deepu') && !di.body.rows.some(x => x.trainers.some(t => t.name === 'Deepu')));
  await User.updateOne({ _id: deepu._id }, { isActive: true });
  r = await http('PATCH', '/api/performance/round/3', { token: T(admin), body: { tracked: true } });
  const o3 = await Cycle.findById(old._id);
  ok('round toggle tracks every cycle of that number', r.status === 200 && o3.track.tracked === true);

  console.log('\n— two trainers: lead, owners, per-day credit, waiting on');
  {
    const A = await User.create({ name: 'Trainer A', email: 'ta@x.com', password: 'longpassword1', role: 'trainer' });
    const B = await User.create({ name: 'Trainer B', email: 'tb@x.com', password: 'longpassword1', role: 'trainer' });
    const X = await User.create({ name: 'Outsider', email: 'tx@x.com', password: 'longpassword1', role: 'trainer' });
    const duo = await Batch.create({ name: 'Duo Batch', semester: sem._id, trainers: [A._id, B._id] });
    const st = await Student.create({ name: 'Ravi', roll: '901', batch: duo._id, semester: sem._id });
    const cy = await Cycle.create({ batch: duo._id, semester: sem._id, number: 7, startDate: day(-10), endDate: day(-3),
      track: { tracked: true, deadline: new Date(Date.now() - 2 * DAY) } });
    // 1st-year style batch: different cycle number, same deadline → same period
    const other = await Cycle.create({ batch: bca._id, semester: sem._id, number: 1, startDate: day(-60), endDate: day(-3),
      track: { tracked: true, deadline: new Date(Date.now() - 2 * DAY) } });
    const per = perf.istYmd(perf.deadlineOf(cy));
    let dd = await http('GET', `/api/performance?period=${per}`, { token: T(A) });
    ok('period groups cycles with different numbers but the same deadline', dd.status === 200 && dd.body.period === per
      && dd.body.rows.some(r => r.number === 7) && dd.body.rows.some(r => r.number === 1), JSON.stringify(dd.body.rows?.map(r => [r.batch, r.number])));
    let row = dd.body.rows.find(r => r.batch === 'Duo Batch');
    ok('default lead = first trainer, owns every task', row.lead?.name === 'Trainer A' && Object.values(row.owners).every(o => o?.name === 'Trainer A'));

    // B owns marks; plan: class on day -9 taught by B, day -8 by A
    let r = await http('PATCH', `/api/performance/cycle/${cy._id}`, { token: T(admin), body: { owners: { marks: String(B._id) } } });
    ok('admin sets marks owner = B', r.status === 200);
    r = await http('PATCH', `/api/performance/cycle/${cy._id}`, { token: T(admin), body: { lead: String(X._id) } });
    ok('lead must be a trainer of the batch', r.status === 400);
    await http('PUT', `/api/cycleplans/${cy._id}`, { token: T(A), body: { classes: [
      { title: 'Day by B', date: ymd(day(-9)), trainer: String(B._id) }, { title: 'Day by A', date: ymd(day(-8)), trainer: String(A._id) }] } });
    // A logs both days late; B logs nothing of his own
    for (const d of [-9, -8]) {
      await http('POST', '/api/logs', { token: T(A), body: { batch: duo._id, date: ymd(day(d)), notes: 'x' } });
    }
    await DailyLog.collection.updateOne({ batch: duo._id, date: day(-8) }, { $set: { createdAt: new Date(day(-8).getTime() + 6 * 3600e3) } });
    // report + top3 done by A on time-ish (before deadline), marks never done
    await Cycle.updateOne({ _id: cy._id }, { $set: { 'track.report': { at: new Date(Date.now() - 3 * DAY), by: A._id, admin: false },
      'track.top3': { at: new Date(Date.now() - 3 * DAY), by: A._id, admin: false } } });
    dd = await http('GET', `/api/performance?period=${per}`, { token: T(B) });
    row = dd.body.rows.find(r => r.batch === 'Duo Batch');
    const pA = row.perTrainer.find(p => p.name === 'Trainer A'), pB = row.perTrainer.find(p => p.name === 'Trainer B');
    ok('missing marks count against owner B, not A', pB.items.marks?.state === 'missing' && !pA.items.marks, JSON.stringify({ a: pA.items.marks, b: pB.items.marks }));
    ok('report/top3/plan scored only for A', pA.items.report?.state === 'on-time' && !pB.items.report && pA.items.plan && !pB.items.plan);
    ok('day planned for B counts for B; day planned for A counts for A', pB.items.logs?.days === 1 && pA.items.logs?.days === 1, JSON.stringify({ a: pA.items.logs, b: pB.items.logs }));
    ok('A logged his own day on time; B\'s day was logged late (by A)', pA.items.logs.onTime === 1 && pB.items.logs.late === 1);
    ok('A scores higher than B', pA.score > pB.score, `${pA.score} vs ${pB.score}`);
    const tA = dd.body.trainers.find(t => t.name === 'Trainer A');
    ok('trainer table uses per-trainer scores', tA && tA.thisCycle === pA.score, JSON.stringify(dd.body.trainers));

    // waiting on: B owns marks and waits on A
    await http('PATCH', `/api/performance/cycle/${cy._id}`, { token: T(admin), body: { owners: { marks: String(A._id) } } });
    r = await http('POST', `/api/performance/cycle/${cy._id}/wait`, { token: T(B), body: { item: 'marks', waitingOn: String(A._id) } });
    ok('non-owner cannot raise a wait', r.status === 403, r.status);
    await http('PATCH', `/api/performance/cycle/${cy._id}`, { token: T(admin), body: { owners: { marks: String(B._id) } } });
    r = await http('POST', `/api/performance/cycle/${cy._id}/wait`, { token: T(B), body: { item: 'marks', waitingOn: String(X._id) } });
    ok('can only wait on a trainer of this batch', r.status === 400);
    // raise it *before* the deadline (simulate by editing raisedAt after)
    r = await http('POST', `/api/performance/cycle/${cy._id}/wait`, { token: T(B), body: { item: 'marks', waitingOn: String(A._id), note: 'A has not evaluated his half' } });
    ok('owner raises "waiting on A"', r.status === 201, JSON.stringify(r.body));
    r = await http('POST', `/api/performance/cycle/${cy._id}/wait`, { token: T(B), body: { item: 'marks', waitingOn: String(A._id) } });
    ok('only one pending request per task', r.status === 400);
    let c2 = await Cycle.findById(cy._id);
    c2.track.waits[0].raisedAt = new Date(Date.now() - 2.5 * DAY); c2.markModified('track'); await c2.save();
    dd = await http('GET', `/api/performance?period=${per}`, { token: T(B) });
    row = dd.body.rows.find(r => r.batch === 'Duo Batch');
    ok('pending wait changes nothing', row.perTrainer.find(p => p.name === 'Trainer B').items.marks.state === 'missing' && row.waits[0].status === 'pending');
    r = await http('PATCH', `/api/performance/cycle/${cy._id}/wait/${row.waits[0].id}`, { token: T(B), body: { status: 'approved' } });
    ok('trainer cannot approve', r.status === 403);
    r = await http('PATCH', `/api/performance/cycle/${cy._id}/wait/${row.waits[0].id}`, { token: T(admin), body: { status: 'approved' } });
    dd = await http('GET', `/api/performance?period=${per}`, { token: T(B) });
    row = dd.body.rows.find(r => r.batch === 'Duo Batch');
    const qA = row.perTrainer.find(p => p.name === 'Trainer A'), qB = row.perTrainer.find(p => p.name === 'Trainer B');
    ok('approved: owner B is on time (flagged before deadline)', r.status === 200 && qB.items.marks?.state === 'on-time' && qB.items.marks.waitedOn, JSON.stringify(qB.items.marks));
    ok('approved: lateness moves to A', qA.items.marks?.state === 'missing' && qA.items.marks.blocking, JSON.stringify(qA.items.marks));
    // marks finally done on time → A not penalised
    await Cycle.updateOne({ _id: cy._id }, { $set: { 'track.marks': { at: new Date(Date.now() - 2.2 * DAY), by: A._id, admin: false } } });
    dd = await http('GET', `/api/performance?period=${per}`, { token: T(B) });
    row = dd.body.rows.find(r => r.batch === 'Duo Batch');
    ok('if the work ends up on time, the waited-on trainer is not penalised', !row.perTrainer.find(p => p.name === 'Trainer A').items.marks);
    r = await http('PATCH', `/api/performance/period/${per}`, { token: T(admin), body: { tracked: false } });
    const oo = await Cycle.findById(other._id);
    ok('period toggle updates every cycle due that day', r.status === 200 && r.body.updated >= 2 && oo.track.tracked === false, JSON.stringify(r.body));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
