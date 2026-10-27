// Page-speed profiler — NOT a pass/fail test. Seeds a realistic semester into a
// throwaway database, puts an artificial delay on every database round trip
// (like Render ↔ Atlas in different regions), then times every GET route that
// the website calls when a page opens.
//
//   TEST_MONGO_URI=mongodb://127.0.0.1:27018/profile DB_DELAY_MS=100 node tests/profile.js
//
// For each route: time, database round trips, response size. A route whose time
// is many × the delay is doing queries one after another (the thing to fix).
process.env.JWT_SECRET = 'test-secret';
const net = require('net');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const DELAY = Number(process.env.DB_DELAY_MS || 100);   // each direction
const M = (n) => require('../models/' + n);

function delayProxy(targetHost, targetPort) {
  return new Promise(res => {
    const srv = net.createServer(client => {
      const up = net.connect(targetPort, targetHost);
      const pipe = (from, to) => from.on('data', d => setTimeout(() => to.write(d), DELAY));
      pipe(client, up); pipe(up, client);
      const end = () => { client.destroy(); up.destroy(); };
      client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  const target = new URL(process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27018/profile');
  // seed directly (fast), then reconnect through the delay
  await mongoose.connect(target.href);
  await mongoose.connection.dropDatabase();
  const photo = 'A'.repeat(Number(process.env.PHOTO_KB || 400) * 1024);   // base64 text, like a phone photo
  const admin = await M('User').create({ name: 'Admin', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const trainers = [];
  for (let i = 0; i < 8; i++) trainers.push(await M('User').create({ name: 'T' + i, email: `t${i}@x.com`, password: 'longpassword1', role: 'trainer' }));
  const oldSem = await M('Semester').create({ name: 'Even 2026', status: 'archived' });
  const sem = await M('Semester').create({ name: 'Odd 2026', status: 'active' });
  const day = (o) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + o); return d; };
  const ymd = (d) => d.toISOString().slice(0, 10);
  let firstBatch, firstCycle;
  for (let b = 0; b < 10; b++) {
    const batch = await M('Batch').create({ name: 'Batch ' + b, track: b % 2 ? 'MERN' : 'DSA', semester: sem._id, trainers: [trainers[b % 8]._id, trainers[(b + 1) % 8]._id], schedule: { days: [1, 2, 3, 4, 5] } });
    firstBatch ||= batch;
    const studs = await M('Student').insertMany(Array.from({ length: 60 }, (_, i) => ({ name: `S${b}-${i}`, roll: `${b}${String(i).padStart(3, '0')}`, batch: batch._id, semester: sem._id })));
    for (let c = 1; c <= 4; c++) {
      const start = day(-60 + c * 14), end = day(-60 + c * 14 + 12);
      const cyc = await M('Cycle').create({
        batch: batch._id, semester: sem._id, number: c, name: 'Cycle ' + c, startDate: start, endDate: end,
        status: c < 4 ? 'closed' : 'active', track: { tracked: true, trackedFrom: start },
        report: { submitted: c < 4, top3: c < 4 ? [1, 2, 3].map(r => ({ rank: r, name: studs[r].name, roll: studs[r].roll, photo: { data: photo, contentType: 'image/jpeg' } })) : [] },
      });
      if (b === 0 && c === 4) firstCycle = cyc;
      await M('CyclePlan').create({ cycle: cyc._id, batch: batch._id, semester: sem._id, classes: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: 'Topic ' + i, notes: 'x'.repeat(400), date: ymd(new Date(start.getTime() + i * 864e5)) })) });
      await M('CycleMark').insertMany(studs.map(s => ({ cycle: cyc._id, batch: batch._id, semester: sem._id, student: s._id, assessment: 70, project: 80, status: 'evaluated' })));
    }
    await M('DailyLog').insertMany(Array.from({ length: 45 }, (_, i) => ({ batch: batch._id, semester: sem._id, date: day(-50 + i), loggedBy: trainers[b % 8]._id, status: 'done', notes: 'taught', attendanceTaken: true, attendance: studs.map(s => ({ student: s._id, present: Math.random() > .2 })) })));
  }
  await mongoose.disconnect();

  const proxy = await delayProxy(target.hostname, Number(target.port));
  const via = `mongodb://127.0.0.1:${proxy.address().port}${target.pathname}`;
  await mongoose.connect(via, { monitorCommands: true });
  let trips = 0;
  mongoose.connection.getClient().on('commandStarted', () => trips++);
  require('../services/reqTiming').watch(mongoose.connection.getClient());

  const app = require('../app');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const tAdmin = T(admin), tTrainer = T(trainers[0]);
  const B = firstBatch._id, C = firstCycle._id, S = sem._id, today = ymd(new Date());

  const pages = {
    'Hall of Fame (public)': [['/semesters'], [`/cycles/halloffame?semester=${S}`]],
    'Any page — sign-in check': [['/auth/me', tAdmin], ['/semesters', tAdmin]],
    'Dashboard': [['/logs/oversight', tAdmin]],
    'Batches': [['/batches', tAdmin], ['/batches/mine', tTrainer], ['/auth/users', tAdmin]],
    'Batch page': [[`/batches/${B}`, tTrainer], [`/students?batch=${B}`, tTrainer], [`/cycleplans/for-date/lookup?batch=${B}&date=${today}`, tTrainer], [`/logs/one?batch=${B}&date=${today}`, tTrainer], [`/plans/${B}`, tTrainer], [`/toppers?batch=${B}`, tTrainer], [`/student-admin/batch/${B}`, tTrainer]],
    'Cycles': [['/cycles', tAdmin], [`/cycles?semester=${S}`, tAdmin]],
    'Cycle report': [[`/cycles/${C}`, tTrainer], [`/marks/${C}/top3-suggestion`, tTrainer]],
    'Cycle marks': [[`/marks/${C}`, tTrainer], [`/student-admin/cycle/${C}/submissions`, tTrainer]],
    'Cycle plan': [[`/cycleplans/${C}`, tTrainer]],
    'Class plans board': [[`/cycleplans/board?semester=${S}`, tAdmin], ['/cycleplans/board', tTrainer]],
    'Performance': [['/performance', tAdmin], ['/performance', tTrainer]],
    'Meetings': [['/meeting/day', tAdmin], ['/meeting/review', tAdmin], ['/feedback/windows', tAdmin]],
    'Top students': [['/students/top', tAdmin], ['/students/top', tTrainer]],
    'Settings / planner': [['/settings/timetables', tAdmin], ['/settings/holidays', tAdmin], ['/batches', tAdmin]],
    'Users': [['/auth/users', tAdmin]],
    'Duplicates': [['/students/duplicates', tAdmin]],
    'Connect AI': [['/tokens', tAdmin], ['/tokens/activity', tAdmin]],
  };
  const rows = [];
  for (const [page, calls] of Object.entries(pages)) {
    for (const [path, token] of calls) {
      trips = 0;
      const t = Date.now();
      const r = await fetch(base + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      const body = await r.arrayBuffer();
      rows.push({ page, path: path.replace(/[a-f0-9]{24}/g, ':id').slice(0, 58), status: r.status, ms: Date.now() - t, trips, kb: Math.round(body.byteLength / 1024), gzip: r.headers.get('content-encoding') || '', st: r.headers.get('server-timing') || '' });
    }
  }
  const w = (s, n) => String(s).padEnd(n);
  console.log(`\nDB delay ${DELAY * 2} ms per round trip · photo ${process.env.PHOTO_KB || 400} KB\n`);
  console.log(w('page', 26) + w('route', 60) + w('st', 5) + w('ms', 7) + w('trips', 7) + w('KB', 8) + 'enc');
  for (const r of rows) console.log(w(r.page, 26) + w(r.path, 60) + w(r.status, 5) + w(r.ms, 7) + w(r.trips, 7) + w(r.kb, 8) + w(r.gzip, 6) + r.st);
  if (process.env.PROFILE_JSON) require('fs').writeFileSync(process.env.PROFILE_JSON, JSON.stringify(rows, null, 1));
  server.close(); proxy.close(); await mongoose.disconnect(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
