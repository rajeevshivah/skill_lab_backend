// MCP ADMIN tools test (round 3) — real Express app (all routes) + official
// MCP client against a throwaway MongoDB. Never touches Atlas.
//
//   npm run test:mcp-admin
process.env.JWT_SECRET = 'test-secret';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const User = require('../models/User'), Semester = require('../models/Semester'), Batch = require('../models/Batch');
const Student = require('../models/Student'), Cycle = require('../models/Cycle'), Plan = require('../models/Plan');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x); } };

let base;
const http = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
async function connect(tok) {
  const c = new Client({ name: 'a-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent, text: r.content?.[0]?.text };
};
async function yes(c, name, args) {
  const p = await call(c, name, args);
  if (p.isError) return { preview: p, saved: p };
  return { preview: p, saved: await call(c, name, { ...args, confirm: true, preview_token: p.data.preview_token }) };
}
const login = (email, password) => http('POST', '/api/auth/login', { body: { email, password } });

(async () => {
  const mongod = process.env.TEST_MONGO_URI ? null : await MongoMemoryServer.create();
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();

  const app = express(); app.use(express.json({ limit: '10mb' }));
  for (const [p, r] of [['auth', 'auth'], ['semesters', 'semesters'], ['batches', 'batches'], ['students', 'students'], ['plans', 'plans'],
    ['logs', 'logs'], ['cycles', 'cycles'], ['marks', 'cyclemarks'], ['cycleplans', 'cycleplans'], ['tokens', 'tokens']])
    app.use(`/api/${p}`, require(`../routes/${r}`));
  app.use('/mcp', require('../mcp'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = await User.create({ name: 'Rajeev Shivah', email: 'admin@sheat.ac.in', password: 'longpassword1', role: 'superadmin' });
  const saif  = await User.create({ name: 'Saif Ali', email: 'saif@x.com', password: 'longpassword1', role: 'trainer' });
  const samant = await User.create({ name: 'Mr Samant', email: 'samant@x.com', password: 'longpassword1', role: 'trainer' });
  const sem = await Semester.create({ name: 'Odd sem 2026-2027', status: 'active' });
  const mern = await Batch.create({ name: 'Full Stack', track: 'MERN', semester: sem._id, trainers: [saif._id] });
  const da   = await Batch.create({ name: 'Data Analyst', track: 'Data Analysis', semester: sem._id, trainers: [] });
  await Plan.create({ batch: mern._id, semester: sem._id, topics: [{ title: 'HTML', order: 0, status: 'done' }, { title: 'CSS', order: 1 }] });
  await Plan.create({ batch: da._id, semester: sem._id, topics: [] });
  const s1 = await Student.create({ name: 'Aman', roll: '101', batch: mern._id, semester: sem._id });
  await Cycle.create({ batch: da._id, semester: sem._id, number: 1, startDate: new Date('2026-10-01'), endDate: new Date('2026-10-14') });

  const J = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);
  const mk = async (u) => (await http('POST', '/api/tokens', { token: J(u), body: { name: 'test' } })).body.token;
  const cA = await connect(await mk(admin));
  const samantTok = await mk(samant);
  let cT = await connect(samantTok);

  console.log('\n1. Who sees which tools');
  const aNames = (await cA.listTools()).tools.map(t => t.name);
  const tNames = (await cT.listTools()).tools.map(t => t.name);
  ok('superadmin sees 33 tools', aNames.length === 33, aNames.length);
  ok('trainer sees 21 tools (no admin ones)', tNames.length === 21, tNames.length);
  ok('trainer does NOT see create_user / update_batch / create_cycles', !['create_user', 'update_batch', 'create_cycles', 'list_users'].some(n => tNames.includes(n)));
  ok('trainer sees add_students / edit_student / set_batch_plan', ['add_students', 'edit_student', 'set_batch_plan'].every(n => tNames.includes(n)));
  ok('no tool can delete', !aNames.some(n => /delete|remove_/.test(n)));
  ok('trainer calling admin tool anyway → refused', (await call(cT, 'create_user', { name: 'X Y', email: 'x@y.com' })).isError);

  console.log('\n2. Users');
  const lu = await call(cA, 'list_users');
  ok('list_users shows batches per user', lu.data.users.find(u => u.name === 'Saif Ali').batches.includes('Full Stack'));
  ok('existing email refused', /already has an account/.test((await call(cA, 'create_user', { name: 'Saif', email: 'SAIF@x.com' })).text));
  const cu = await yes(cA, 'create_user', { name: 'Neha Singh', email: 'neha@sheat.ac.in' });
  ok('create_user preview hides password', /generated/.test(cu.preview.data.changes.password) && !cu.preview.data.temporaryPassword);
  ok('create_user saved + temp password returned once', cu.saved.data?.saved && /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(cu.saved.data.temporaryPassword), cu.saved.text);
  ok('new trainer can log in with temp password', (await login('neha@sheat.ac.in', cu.saved.data.temporaryPassword)).status === 200);
  ok('new user role defaults to trainer', (await User.findOne({ email: 'neha@sheat.ac.in' })).role === 'trainer');
  const rp = await yes(cA, 'update_user', { user: 'neha@sheat.ac.in', reset_password: true });
  ok('reset_password → new one works', (await login('neha@sheat.ac.in', rp.saved.data.temporaryPassword)).status === 200);
  ok('old password no longer works', (await login('neha@sheat.ac.in', cu.saved.data.temporaryPassword)).status === 401);
  const deact = await yes(cA, 'update_user', { user: 'Saif', active: false });
  ok('deactivate preview warns he is still on a batch', deact.preview.data.warnings.some(w => /still listed as trainer on 1 batch/.test(w)));
  ok('deactivated user cannot log in', (await login('saif@x.com', 'longpassword1')).status === 401);
  const demote = await yes(cA, 'update_user', { user: 'admin@sheat.ac.in', role: 'trainer' });
  ok('own-account warning in preview', demote.preview.data.warnings.some(w => /YOUR OWN/.test(w)));
  ok('last superadmin cannot be demoted (website rule)', demote.saved.isError && /only active superadmin/.test(demote.saved.text), demote.saved.text);
  ok('ambiguous name refused', /several users|No user/.test((await call(cA, 'update_user', { user: 'a', active: true })).text));

  console.log('\n3. Batches');
  const ub = await yes(cA, 'update_batch', { batch_id: String(mern._id), add_trainers: ['Rajeev', 'samant@x.com'], remove_trainers: ['Saif Ali'] });
  ok('trainer swap preview: from → to', JSON.stringify(ub.preview.data.changes[0].to) === JSON.stringify(['Rajeev Shivah', 'Mr Samant']), JSON.stringify(ub.preview.data.changes));
  ok('trainer swap saved', ub.saved.data?.saved, ub.saved.text);
  const mernNow = await Batch.findById(mern._id).populate('trainers', 'name');
  ok('Full Stack trainers now Rajeev + Samant', mernNow.trainers.map(t => t.name).sort().join(',') === 'Mr Samant,Rajeev Shivah');
  await cT.close(); cT = await connect(samantTok);
  ok('Samant can now see Full Stack via AI', (await call(cT, 'whoami')).data.batches.some(b => b.name === 'Full Stack'));
  const cb = await yes(cA, 'create_batch', { name: 'Full Stack 2', track: 'MERN', composition: 'BTech 7th', trainers: ['Mr Samant'], copy_plan_from_batch_id: String(mern._id) });
  ok('create_batch preview: copies 2 topics', /copy 2 topics/.test(cb.preview.data.changes.syllabus));
  ok('create_batch saved', cb.saved.data?.saved, cb.saved.text);
  const fs2 = await Batch.findOne({ name: 'Full Stack 2' });
  ok('new batch has plan with 2 pending topics', (await Plan.findOne({ batch: fs2._id })).topics.every(t => t.status === 'pending'));
  ok('duplicate batch name refused', (await call(cA, 'create_batch', { name: 'Full Stack 2' })).isError);
  ok('roster lock saved', (await yes(cA, 'set_roster_lock', { batch_id: String(da._id), locked: true })).saved.data?.rosterLocked === true);
  ok('retire batch (inactive) — nothing deleted', (await yes(cA, 'update_batch', { batch_id: String(fs2._id), active: false })).saved.data?.saved && await Batch.exists({ _id: fs2._id }));

  console.log('\n4. Cycles');
  const cc = await yes(cA, 'create_cycles', { batch_ids: [String(mern._id), String(da._id)], start_date: '2026-10-05', end_date: '2026-10-18' });
  ok('preview: MERN cycle 1, Data Analyst skipped (overlap)', cc.preview.data.changes[0].willCreate && !cc.preview.data.changes[1].willCreate);
  ok('bulk create saved 1, skipped 1', cc.saved.data?.created?.length === 1 && cc.saved.data.skipped.length === 1, cc.saved.text);
  const mc = await Cycle.findOne({ batch: mern._id });
  ok('end before start refused', (await call(cA, 'create_cycles', { batch_ids: [String(mern._id)], start_date: '2026-11-10', end_date: '2026-11-01' })).isError);
  ok('update_cycle dates', (await yes(cA, 'update_cycle', { cycle_id: String(mc._id), end_date: '2026-10-20' })).saved.data?.cycle?.end === '2026-10-20');
  ok('open report', (await yes(cA, 'set_cycle_status', { cycle_id: String(mc._id), action: 'open_report' })).saved.data?.status === 'report-open');
  const close = await yes(cA, 'set_cycle_status', { cycle_id: String(mc._id), action: 'close' });
  ok('close warns report not submitted', close.preview.data.warnings.some(w => /NOT submitted/.test(w)));
  ok('close saved', close.saved.data?.status === 'closed');
  ok('editing closed cycle refused', /closed/.test((await call(cA, 'update_cycle', { cycle_id: String(mc._id), name: 'x' })).text));

  console.log('\n5. Students');
  const as = await yes(cT, 'add_students', { batch_id: String(mern._id), students: [
    { roll: '101', name: 'Aman again' }, { roll: '102', name: 'Bhavna', course: 'BTech', section: 'A' }, { roll: '10 3', name: 'Bad Roll' }, { roll: '201', name: 'Divya' } ] });
  ok('preview: 2 to add, 2 skipped', as.preview.data.changes.willAdd === 2 && as.preview.data.changes.skipped.length === 2, JSON.stringify(as.preview.data.changes));
  ok('trainer (Samant) added students to own batch', as.saved.data?.added === 2, as.saved.text);
  ok('trainer cannot add to other batch', (await call(cT, 'add_students', { batch_id: String(da._id), students: [{ name: 'X' }] })).isError);
  const clash = await yes(cT, 'edit_student', { roll: '102', batch_id: String(mern._id), new_roll: '101' });
  ok('roll clash refused by website rule', clash.saved.isError && /already belongs/.test(clash.saved.text), clash.saved.text);
  ok('edit_student flag', (await yes(cT, 'edit_student', { roll: '102', batch_id: String(mern._id), flagged: true })).saved.data?.saved);
  const mv = await yes(cA, 'move_student', { student_id: String(s1._id), to_batch_id: String(da._id) });
  ok('move_student saved', mv.saved.data?.movedTo === 'Data Analyst' && String((await Student.findById(s1._id)).batch) === String(da._id));

  console.log('\n6. Syllabus plan');
  const ap = await yes(cT, 'set_batch_plan', { batch_id: String(mern._id), mode: 'append', topics: ['CSS', 'JavaScript', 'React'] });
  ok('append adds only new topics', JSON.stringify(ap.preview.data.changes.added) === JSON.stringify(['JavaScript', 'React']));
  const rp2 = await yes(cT, 'set_batch_plan', { batch_id: String(mern._id), mode: 'replace', topics: ['HTML', 'React'] });
  ok('replace: no done topic lost (HTML kept), 2 removed', !(rp2.preview.data.warnings || []).length && rp2.preview.data.changes.removed.length === 2);
  ok('replace saved', rp2.saved.data?.saved === true, rp2.saved.text);
  const pl = await Plan.findOne({ batch: mern._id });
  ok('replace kept HTML as done', pl.topics.length === 2 && pl.topics.find(t => t.title === 'HTML').status === 'done');

  console.log('\n7. Semesters');
  const ns = await yes(cA, 'create_semester', { name: 'Even sem 2026-2027' });
  ok('create_semester warns current will be archived', ns.preview.data.warnings.some(w => /ARCHIVED/.test(w)));
  ok('new semester active, old archived', (await Semester.findOne({ status: 'active' })).name === 'Even sem 2026-2027' && (await Semester.findById(sem._id)).status === 'archived');
  ok('reactivate old semester', (await yes(cA, 'update_semester', { semester: 'Odd sem', status: 'active' })).saved.data?.semester?.status === 'active');
  ok('only one active', (await Semester.countDocuments({ status: 'active' })) === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  await cA.close(); await cT.close();
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
