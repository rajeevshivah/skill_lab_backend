// MCP WRITE tools test (round 2) — real Express app + official MCP client
// against a throwaway MongoDB. Never touches Atlas.
//
//   npm run test:mcp-write
process.env.JWT_SECRET = 'test-secret';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const User = require('../models/User'), Semester = require('../models/Semester'), Batch = require('../models/Batch');
const Student = require('../models/Student'), Cycle = require('../models/Cycle'), CycleMark = require('../models/CycleMark');
const CyclePlan = require('../models/CyclePlan'), DailyLog = require('../models/DailyLog'), Plan = require('../models/Plan');
const McpAuditLog = require('../models/McpAuditLog');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x); } };

let base;
const http = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
async function connect(tok) {
  const c = new Client({ name: 'w-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent, text: r.content?.[0]?.text };
};
// preview, then confirm with the token (what the AI does after the user says yes)
async function previewAndConfirm(c, name, args) {
  const p = await call(c, name, args);
  if (p.isError) return { preview: p, saved: p };
  const s = await call(c, name, { ...args, confirm: true, preview_token: p.data.preview_token });
  return { preview: p, saved: s };
}

(async () => {
  const mongod = process.env.TEST_MONGO_URI ? null : await MongoMemoryServer.create();
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();

  const app = express(); app.use(express.json());
  app.use('/api/tokens', require('../routes/tokens'));
  app.use('/api/marks', require('../routes/cyclemarks'));
  app.use('/api/cycles', require('../routes/cycles'));
  app.use('/api/logs', require('../routes/logs'));
  app.use('/api/cycleplans', require('../routes/cycleplans'));
  app.use('/mcp', require('../mcp'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  // fixtures
  const admin = await User.create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const samant = await User.create({ name: 'Mr Samant', email: 's@x.com', password: 'longpassword1', role: 'trainer' });
  const lucky = await User.create({ name: 'Lucky Chandra Verma', email: 'l@x.com', password: 'longpassword1', role: 'trainer' });
  const deepu = await User.create({ name: 'Deepu', email: 'd@x.com', password: 'longpassword1', role: 'trainer' });
  const sem = await Semester.create({ name: 'Odd 2026', status: 'active' });
  const mern = await Batch.create({ name: 'Full Stack', track: 'MERN', semester: sem._id, trainers: [samant._id, lucky._id] });
  const other = await Batch.create({ name: 'BCA 3 A', semester: sem._id, trainers: [deepu._id] });
  await Plan.create({ batch: mern._id, semester: sem._id, topics: [{ title: 'useState hook' }, { title: 'Express routing' }] });
  const S = [];
  for (const [r, n] of [['101', 'Aman'], ['102', 'Bhavna'], ['103', 'Chetan'], ['104', 'Divya']])
    S.push(await Student.create({ name: n, roll: r, batch: mern._id, semester: sem._id }));
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const cyc = await Cycle.create({ batch: mern._id, semester: sem._id, number: 2, startDate: new Date(Date.now() - 7 * 864e5), endDate: new Date(Date.now() + 7 * 864e5) });
  const closed = await Cycle.create({ batch: mern._id, semester: sem._id, number: 1, status: 'closed', startDate: new Date(Date.now() - 30 * 864e5), endDate: new Date(Date.now() - 16 * 864e5) });
  await CycleMark.create({ cycle: cyc._id, batch: mern._id, semester: sem._id, student: S[0]._id, status: 'evaluated', assessment: 40, project: 40, category: 'excellent', categoryOverridden: true, remark: 'great demo' });
  cyc.report.top3 = [{ rank: 1, student: S[0]._id, name: 'Aman', roll: '101', github: 'gh/aman', photo: { data: 'AAAA', contentType: 'image/png' } }];
  await cyc.save();

  const J = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const mk = async (u) => (await http('POST', '/api/tokens', { token: J(u), body: { name: 'test' } })).body.token;
  const cS = await connect(await mk(samant)), cA = await connect(await mk(admin));
  const cL = await connect(await mk(lucky)), cD = await connect(await mk(deepu));

  console.log('\n1. Tool list');
  const { tools } = await cS.listTools();
  const W = ['fill_cycle_report', 'update_cycle_marks', 'set_cycle_top3', 'save_daily_log', 'save_cycle_plan_class'];
  ok('16 tools (11 read + 5 write)', tools.length === 16, tools.length);
  ok('write tools are NOT marked read-only', W.every(n => tools.find(t => t.name === n)?.annotations?.readOnlyHint === false));
  ok('read tools still read-only', tools.filter(t => !W.includes(t.name)).every(t => t.annotations.readOnlyHint === true));
  ok('instructions tell AI to wait for yes', /explicit "yes"/.test(cS.getInstructions()));

  console.log('\n2. Preview never saves; confirm needs a matching token');
  const rep = { cycle_id: String(cyc._id), syllabus_coverage: 'behind', problems_faced: 'Lab internet down twice', performance_rating: 4 };
  const notOpen = await call(cS, 'fill_cycle_report', rep);
  ok('trainer: report not open yet → refused', notOpen.isError && /not open yet/.test(notOpen.text));
  await Cycle.updateOne({ _id: cyc._id }, { status: 'report-open' });
  const pv = await call(cS, 'fill_cycle_report', rep);
  ok('preview returned', pv.data?.mode === 'preview' && pv.data.saved === false && pv.data.changes.length === 3);
  ok('preview shows from → to', pv.data.changes.find(c => c.field === 'Syllabus coverage')?.to === 'behind');
  ok('DB unchanged after preview', (await Cycle.findById(cyc._id)).report.problemsFaced === '');
  const noTok = await call(cS, 'fill_cycle_report', { ...rep, confirm: true });
  ok('confirm without token → refused', noTok.isError && /preview_token/.test(noTok.text));
  const changed = await call(cS, 'fill_cycle_report', { ...rep, performance_rating: 5, confirm: true, preview_token: pv.data.preview_token });
  ok('confirm with CHANGED args → refused', changed.isError && /arguments changed/.test(changed.text));
  const otherTool = await call(cS, 'update_cycle_marks', { cycle_id: String(cyc._id), rows: [{ roll: '102', state: 'not-evaluated' }], confirm: true, preview_token: pv.data.preview_token });
  ok('token from another tool → refused', otherTool.isError);
  const stolen = await call(cL, 'fill_cycle_report', { ...rep, confirm: true, preview_token: pv.data.preview_token });
  ok('token used by another user → refused', stolen.isError);
  const saved = await call(cS, 'fill_cycle_report', { ...rep, confirm: true, preview_token: pv.data.preview_token });
  ok('confirm with right token → saved', saved.data?.mode === 'saved' && saved.data.saved === true, saved.text);
  const c2 = await Cycle.findById(cyc._id);
  ok('report fields saved + submitted', c2.report.syllabusCoverage === 'behind' && c2.report.performanceRating === 4 && c2.report.submitted === true);
  ok('untouched report fields kept', c2.report.top3.length === 1 && c2.report.top3[0].github === 'gh/aman');

  console.log('\n3. Permissions same as website');
  ok('other batch trainer → refused', (await call(cD, 'fill_cycle_report', rep)).isError);
  ok('closed cycle → refused', /closed/.test((await call(cA, 'fill_cycle_report', { cycle_id: String(closed._id), reflection: 'x' })).text));
  ok('no fields → refused', (await call(cS, 'fill_cycle_report', { cycle_id: String(cyc._id) })).isError);

  console.log('\n4. update_cycle_marks');
  const badRoll = await call(cS, 'update_cycle_marks', { cycle_id: String(cyc._id), rows: [{ roll: '999', state: 'not-evaluated' }] });
  ok('unknown roll → refused, nothing saved', badRoll.isError && /999 is not in this batch/.test(badRoll.text));
  const half = await call(cS, 'update_cycle_marks', { cycle_id: String(cyc._id), rows: [{ roll: '102', state: 'evaluated', assessment: 50 }] });
  ok('evaluated without project → refused', half.isError && /both assessment and project/.test(half.text));
  const mArgs = { cycle_id: String(cyc._id), rows: [
    { roll: '101', state: 'evaluated', assessment: 70, project: 80 },
    { roll: '102', state: 'evaluated', assessment: 0, project: 0 },
    { roll: '103', state: 'not-evaluated' },
  ] };
  const m = await previewAndConfirm(cS, 'update_cycle_marks', mArgs);
  ok('marks preview: from → to', m.preview.data.changes[0].from.total === 80 && m.preview.data.changes[0].to.total === 150);
  ok('preview flags override removal', m.preview.data.changes[0].note === 'manual category override removed');
  ok('marks saved', m.saved.data?.saved === true, m.saved.text);
  const mk1 = await CycleMark.findOne({ cycle: cyc._id, student: S[0]._id });
  ok('101 = 150 excellent, remark kept', mk1.assessment === 70 && mk1.category === 'excellent' && mk1.remark === 'great demo');
  ok('102 = zero', (await CycleMark.findOne({ cycle: cyc._id, student: S[1]._id })).category === 'zero');
  ok('103 = not-evaluated', (await CycleMark.findOne({ cycle: cyc._id, student: S[2]._id })).status === 'not-evaluated');
  ok('104 untouched (no row)', !(await CycleMark.findOne({ cycle: cyc._id, student: S[3]._id })));
  const web = await http('PUT', `/api/marks/${cyc._id}`, { token: J(samant), body: { rows: [{ student: S[3]._id, status: 'evaluated', assessment: 101, project: 0 }] } });
  ok('website marks route still validates (101 → 400)', web.status === 400 && /Nothing was saved/.test(web.body.message));

  console.log('\n5. set_cycle_top3');
  const dup = await call(cS, 'set_cycle_top3', { cycle_id: String(cyc._id), top3: [{ rank: 1, roll: '101' }, { rank: 1, roll: '102' }] });
  ok('duplicate rank → refused', dup.isError);
  const t = await previewAndConfirm(cS, 'set_cycle_top3', { cycle_id: String(cyc._id), top3: [{ rank: 1, roll: '101' }, { rank: 2, roll: '102', github: 'gh/bhavna' }, { rank: 3, roll: '104' }] });
  ok('top3 preview warns: 104 not evaluated', t.preview.data.warnings.some(w => /Divya/.test(w)));
  ok('top3 saved', t.saved.data?.saved === true, t.saved.text);
  const c3 = await Cycle.findById(cyc._id);
  ok('Aman photo + github kept', c3.report.top3[0].photo.data === 'AAAA' && c3.report.top3[0].github === 'gh/aman');
  ok('3 entries in rank order', c3.report.top3.map(x => x.roll).join(',') === '101,102,104');

  console.log('\n6. save_daily_log');
  const fut = await call(cS, 'save_daily_log', { batch_id: String(mern._id), date: '2099-01-01', notes: 'x' });
  ok('future date → refused', fut.isError && /future/.test(fut.text));
  const badTopic = await call(cS, 'save_daily_log', { batch_id: String(mern._id), date: today, topics_covered: ['Docker'] });
  ok('unknown topic → refused with plan list', badTopic.isError && /useState hook/.test(badTopic.text));
  const lg = await previewAndConfirm(cS, 'save_daily_log', { batch_id: String(mern._id), date: today, notes: 'useState demo', topics_covered: ['usestate'], attendance: { mode: 'absent', rolls: ['102'] } });
  ok('log preview: 3 present, Bhavna absent', lg.preview.data.changes.attendance.present === 3 && /Bhavna/.test(lg.preview.data.changes.attendance.absentees[0]));
  ok('log saved', lg.saved.data?.saved === true, lg.saved.text);
  const l1 = await DailyLog.findOne({ batch: mern._id });
  ok('attendance taken + 4 entries', l1.attendanceTaken === true && l1.attendance.length === 4);
  ok('plan topic ticked done', (await Plan.findOne({ batch: mern._id })).topics[0].status === 'done');
  ok('student attendance stats recomputed', (await Student.findById(S[0]._id)).stats.totalSessions === 1);
  // second trainer (Lucky) adds only a prep link — notes + attendance must be kept
  const lg2 = await previewAndConfirm(cL, 'save_daily_log', { batch_id: String(mern._id), date: today, prep_link: 'github.com/lucky/prep' });
  ok('existing-log warning shown', lg2.preview.data.warnings.some(w => /already exists/.test(w)));
  const l2 = await DailyLog.findOne({ batch: mern._id });
  ok('merge: notes + attendance kept, link added', l2.notes === 'useState demo' && l2.attendance.length === 4 && l2.prepLink === 'github.com/lucky/prep');
  ok('both trainers recorded as contributors', l2.contributors.length === 2);
  ok('other batch trainer cannot log here', (await call(cD, 'save_daily_log', { batch_id: String(mern._id), date: today, notes: 'x' })).isError);

  console.log('\n7. save_cycle_plan_class');
  const np = await call(cS, 'save_cycle_plan_class', { cycle_id: String(cyc._id), notes: 'x' });
  ok('new class without title → refused', np.isError && /needs a title/.test(np.text));
  const badT = await call(cS, 'save_cycle_plan_class', { cycle_id: String(cyc._id), title: 'Intro', trainer: 'Deepu' });
  ok('trainer not in batch → refused', badT.isError && /not a trainer of this batch/.test(badT.text));
  const a1 = await previewAndConfirm(cS, 'save_cycle_plan_class', { cycle_id: String(cyc._id), title: 'Express routing', date: today, trainer: 'samant' });
  ok('class added', a1.saved.data?.classNumber === 1, a1.saved.text);
  const a2 = await previewAndConfirm(cS, 'save_cycle_plan_class', { cycle_id: String(cyc._id), class_number: 1, time: '10:00' });
  ok('edit preview shows from → to', a2.preview.data.changes.from.title === 'Express routing' && a2.preview.data.changes.to.time === '10:00');
  const p1 = await CyclePlan.findOne({ cycle: cyc._id }).populate('classes.trainer', 'name');
  ok('edit kept title + trainer, set time', p1.classes.length === 1 && p1.classes[0].title === 'Express routing' && p1.classes[0].time === '10:00' && p1.classes[0].trainer.name === 'Mr Samant');
  await previewAndConfirm(cS, 'save_cycle_plan_class', { cycle_id: String(cyc._id), title: 'Middleware' });
  ok('second class gets number 2', (await CyclePlan.findOne({ cycle: cyc._id })).classes.map(c => c.number).join(',') === '1,2');

  console.log('\n8. Audit log');
  await new Promise(r => setTimeout(r, 300));
  const writes = await McpAuditLog.find({ kind: 'write' });
  const previews = await McpAuditLog.find({ kind: 'preview' });
  ok('saved changes audited as write', writes.length >= 7, writes.length);
  ok('previews audited as preview', previews.length >= 7);
  ok('preview_token not stored in audit', !(await McpAuditLog.findOne({ args: /preview_token/ })));
  const act = await http('GET', '/api/tokens/activity?kind=write', { token: J(admin) });
  ok('activity ?kind=write filter', act.body.activity.length && act.body.activity.every(a => a.kind === 'write'));

  console.log(`\n${pass} passed, ${fail} failed`);
  for (const c of [cS, cA, cL, cD]) await c.close();
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
