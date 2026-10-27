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
const CyclePlan = require('../models/CyclePlan'), DailyLog = require('../models/DailyLog');

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
  const college = await require('./college').setup();

  const app = express(); app.use(express.json({ limit: '10mb' })); app.use(require('../middleware/org').resolveOrg);
  for (const [p, r] of [['auth', 'auth'], ['semesters', 'semesters'], ['batches', 'batches'], ['students', 'students'], ['plans', 'plans'],
    ['logs', 'logs'], ['cycles', 'cycles'], ['marks', 'cyclemarks'], ['cycleplans', 'cycleplans'], ['tokens', 'tokens'], ['performance', 'performance'],
    ['settings', 'settings'], ['meeting', 'meeting'], ['feedback', 'feedback'], ['student-admin', 'studentAdmin']])
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
  ok('superadmin sees 61 tools', aNames.length === 61, aNames.length);
  ok('trainer sees 36 tools (no admin ones)', tNames.length === 36, tNames.length);
  ok('trainer does NOT see create_user / update_batch / plan_cycles / add_holiday', !['create_user', 'update_batch', 'plan_cycles', 'add_holiday', 'list_users', 'create_cycles'].some(n => tNames.includes(n)));
  ok('create_cycles is gone (plan_cycles replaces it)', !aNames.includes('create_cycles') && aNames.includes('plan_cycles'));
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
  const pc0 = await call(cA, 'plan_cycles', { groups: [{ batch_ids: [String(mern._id)], start_date: '2026-10-05', end_date: '2026-10-18' }] });
  ok('plan_cycles refused until the timetable is set', pc0.isError && /timetable/i.test(pc0.text), pc0.text);
  ok('set_timetable', (await yes(cA, 'set_timetable', { batch_id: String(mern._id), days: ['mon', 'tue', 'wed', 'thu'] })).saved.data?.days?.join() === '1,2,3,4');
  await yes(cA, 'set_timetable', { batch_id: String(da._id), days: ['mon', 'wed'] });
  const cc = await yes(cA, 'plan_cycles', { groups: [{ name: 'All', batch_ids: [String(mern._id)], start_date: '2026-10-05', end_date: '2026-10-18', project_day: '2026-10-15' }] });
  ok('plan_cycles preview: MERN cycle 1, 8 class days', cc.preview.data?.changes?.[0]?.cycle === 1 && cc.preview.data.changes[0].classDays === 8, cc.preview.text);
  ok('plan_cycles created it', cc.saved.data?.created?.length === 1, cc.saved.text);
  const mc = await Cycle.findOne({ batch: mern._id });
  ok('overlapping plan refused', (await call(cA, 'plan_cycles', { groups: [{ batch_ids: [String(mern._id), String(da._id)], start_date: '2026-10-10', end_date: '2026-10-20' }] })).isError);
  ok('end before start refused', (await call(cA, 'plan_cycles', { groups: [{ batch_ids: [String(mern._id)], start_date: '2026-11-10', end_date: '2026-11-01' }] })).isError);
  ok('trainer cannot plan cycles', (await call(cT, 'plan_cycles', { groups: [{ batch_ids: [String(da._id)], start_date: '2026-12-01', end_date: '2026-12-10' }] })).isError);
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

  console.log('\n— bulk back-filling + accountability (admin)');
  {
    const daCycle = await Cycle.findOne({ batch: da._id, number: 1 });
    const pb = await yes(cA, 'save_cycle_plan_bulk', { cycle_id: String(daCycle._id), classes: [
      { number: 1, title: 'Intro', date: '2026-10-01' }, { number: 2, title: 'Pandas', date: '2026-10-02', notes: 'dataframes' }] });
    ok('bulk plan: preview lists 2 new', pb.preview.data?.changes?.filter(x => x.action === 'add').length === 2, pb.preview.text);
    ok('bulk plan saved', pb.saved.data?.totalClasses === 2, pb.saved.text);
    const pb2 = await yes(cA, 'save_cycle_plan_bulk', { cycle_id: String(daCycle._id), classes: [{ number: 2, title: 'Pandas basics' }, { number: 3, title: 'Charts' }] });
    const cpDoc = await CyclePlan.findOne({ cycle: daCycle._id }).lean();
    ok('bulk plan merges by number (keeps class 1, updates 2, keeps its date)', pb2.saved.data?.totalClasses === 3
      && cpDoc.classes.find(k => k.number === 2).title === 'Pandas basics' && cpDoc.classes.find(k => k.number === 2).date === '2026-10-02');
    const pb3 = await yes(cA, 'save_cycle_plan_bulk', { cycle_id: String(daCycle._id), classes: [{ number: 2, title: 'Pandas + charts' }], remove_numbers: [3] });
    ok('bulk plan can remove classes', pb3.preview.data?.changes?.some(x => x.action === 'remove' && x.number === 3) && pb3.saved.data?.totalClasses === 2, pb3.preview.text);
    ok('removing a class not in the plan is refused', (await call(cA, 'save_cycle_plan_bulk', { cycle_id: String(daCycle._id), remove_numbers: [77] })).isError);
    ok('bulk plan refused for trainer', (await call(cT, 'save_cycle_plan_bulk', { cycle_id: String(daCycle._id), classes: [{ number: 9, title: 'x' }] })).isError);

    await DailyLog.create({ batch: mern._id, semester: sem._id, date: new Date('2026-10-05T00:00:00'), notes: 'trainer wrote this', loggedBy: saif._id,
      attendance: [{ student: s1._id, present: true }], attendanceTaken: true });
    const lb = await yes(cA, 'save_daily_logs_bulk', { batch_id: String(mern._id), logs: [
      { date: '2026-10-05', notes: 'should be skipped' }, { date: '2026-10-06', notes: 'OOP basics' }, { date: '2026-10-07', notes: 'Inheritance' }] });
    ok('bulk logs: existing date skipped in preview', lb.preview.data?.changes?.[0]?.action?.startsWith('skip'), JSON.stringify(lb.preview.data?.changes?.[0]));
    ok('bulk logs: 2 saved', lb.saved.data?.logsSaved === 2, lb.saved.text);
    const kept = await DailyLog.findOne({ batch: mern._id, date: new Date('2026-10-05T00:00:00') });
    ok('existing trainer log untouched', kept.notes === 'trainer wrote this' && kept.attendance.length === 1);
    ok('future date refused', /future/i.test((await call(cA, 'save_daily_logs_bulk', { batch_id: String(mern._id), logs: [{ date: '2099-01-01', notes: 'x' }] })).text));
    const ow = await yes(cA, 'save_daily_logs_bulk', { batch_id: String(mern._id), overwrite: true, logs: [{ date: '2026-10-05', notes: 'rewritten' }] });
    const kept2 = await DailyLog.findOne({ batch: mern._id, date: new Date('2026-10-05T00:00:00') });
    ok('overwrite replaces notes but keeps attendance', ow.saved.data?.logsSaved === 1 && kept2.notes === 'rewritten' && kept2.attendance.length === 1 && kept2.attendanceTaken);

    const acc = await yes(cA, 'set_cycle_accountability', { cycle_id: String(daCycle._id), project_date: '2026-10-14', deadline: '2026-10-17T21:00',
      completions: [{ item: 'report', completed_at: '2026-10-18T21:00', done_by: 'admin' }] });
    const dc = await Cycle.findById(daCycle._id);
    ok('accountability: deadline + admin stamp saved', acc.saved.data?.deadline === '2026-10-17 21:00 IST' && dc.track.report.admin === true, acc.saved.text);
    const noTr = await call(cA, 'set_cycle_accountability', { cycle_id: String(daCycle._id), completions: [{ item: 'marks', completed_at: '2026-10-17T10:00', done_by: 'trainer' }] });
    ok('trainer credit needs a trainer on the batch', noTr.isError && /trainer/.test(noTr.text), noTr.text);
    await User.updateOne({ _id: saif._id }, { isActive: true });
    await Batch.updateOne({ _id: da._id }, { $set: { trainers: [saif._id, samant._id] } });
    const lo = await yes(cA, 'set_cycle_accountability', { cycle_id: String(daCycle._id), lead_trainer: 'Samant', owners: [{ item: 'marks', trainer_name: 'Saif' }] });
    const dc2 = await Cycle.findById(daCycle._id);
    ok('lead + owner set by name', !lo.saved.isError && String(dc2.track.lead) === String(samant._id) && String(dc2.track.owners.marks) === String(saif._id), lo.saved.text || lo.preview.text);
    const bad = await call(cA, 'set_cycle_accountability', { cycle_id: String(daCycle._id), lead_trainer: 'Nobody' });
    ok('unknown lead name refused', bad.isError && /exactly one trainer/.test(bad.text), bad.text);
    const gp = await call(cA, 'get_trainer_performance', {});
    ok('get_trainer_performance returns periods', !gp.isError && Array.isArray(gp.data?.periods), gp.text?.slice(0, 200));
  }

  console.log('\n6. Operations tools (round 4)');
  {
    const daCycle = await Cycle.findOne({ batch: da._id, number: 1 });
    const tt = await call(cA, 'get_timetables', {});
    ok('get_timetables', !tt.isError && tt.data.batches.find(b => b.name === 'Full Stack').source === 'saved', tt.text?.slice(0, 200));
    ok('trainer cannot read timetables tool', (await call(cT, 'get_timetables', {})).isError);
    const hol = await yes(cA, 'add_holiday', { from: '2026-10-07', title: 'Fest', batch_ids: [String(da._id)], mode: 'mark' });
    ok('add_holiday (mark): preview then saved', /Fest/.test(hol.preview.data?.summary || '') && hol.saved.data?.ok, hol.preview.text);
    const lh = await call(cT, 'list_holidays', {});
    const hid = lh.data?.holidays?.find(h => h.title === 'Fest')?._id;
    ok('list_holidays (trainer)', !!hid, lh.text?.slice(0, 200));
    ok('undo_holiday', (await yes(cA, 'undo_holiday', { holiday_id: String(hid) })).saved.data?.ok === true);
    ok('set_plan_editing open', (await yes(cA, 'set_plan_editing', { open: true, cycle_id: String(daCycle._id) })).saved.data?.ok && (await Cycle.findById(daCycle._id)).planOpen);
    ok('set_plan_editing needs cycle or period', (await call(cA, 'set_plan_editing', { open: false })).isError);
    const acc = await call(cT, 'get_student_access', { batch_id: String(da._id) });
    ok('get_student_access (own batch)', !acc.isError && /^[A-Z2-9]{6}$/.test(acc.data.joinCode), acc.text?.slice(0, 200));
    const nj = await yes(cT, 'new_join_code', { batch_id: String(da._id) });
    ok('new_join_code', nj.saved.data?.joinCode && nj.saved.data.joinCode !== acc.data.joinCode);
    const st = await Student.create({ name: 'Zed', roll: '501', batch: da._id, semester: sem._id, login: { passwordHash: 'x', activatedAt: new Date() } });
    ok('reset_student_password', (await yes(cT, 'reset_student_password', { student_id: String(st._id) })).saved.data?.ok === true);
    const sub = await yes(cT, 'set_project_submission', { cycle_id: String(daCycle._id), open: true, minutes: 30 });
    ok('set_project_submission open', sub.saved.data?.window?.open === true, sub.saved.text);
    ok('get_project_submissions shows it open', (await call(cT, 'get_project_submissions', { cycle_id: String(daCycle._id) })).data?.window?.open === true);
    const of = await yes(cA, 'open_feedback', { batch_ids: [String(da._id)], hours: 24, title: 'Test feedback' });
    const wid = of.saved.data?.window?._id;
    ok('open_feedback', !!wid, of.saved.text);
    ok('get_feedback_results list', (await call(cT, 'get_feedback_results', {})).data?.windows?.some(w => String(w._id) === String(wid)));
    ok('get_feedback_results one', !(await call(cT, 'get_feedback_results', { window_id: String(wid) })).isError);
    ok('close_feedback', (await yes(cA, 'close_feedback', { window_id: String(wid), close: true })).saved.data?.ok === true);
    ok('trainer cannot open feedback', (await call(cT, 'open_feedback', { batch_ids: [String(da._id)] })).isError);
    const nt = await yes(cT, 'add_meeting_note', { scope: 'day', date: '2026-10-07', batch_id: String(da._id), text: 'Revise joins' });
    const nid = nt.saved.data?.note?._id;
    ok('add_meeting_note (own batch)', !!nid, nt.saved.text);
    ok('add_meeting_note day needs date', (await call(cT, 'add_meeting_note', { scope: 'day', batch_id: String(da._id), text: 'x' })).isError);
    ok('list_meeting_notes', (await call(cT, 'list_meeting_notes', { scope: 'day', batch_id: String(da._id) })).data?.notes?.length === 1);
    ok('update_meeting_note done', (await yes(cT, 'update_meeting_note', { note_id: String(nid), status: 'done' })).saved.data?.note?.status === 'done');
    const md = await call(cA, 'get_meeting_day', { date: '2026-10-07' });
    ok('get_meeting_day', !md.isError && Array.isArray(md.data.batches), md.text?.slice(0, 200));
    const rv = await call(cA, 'get_cycle_review', {});
    ok('get_cycle_review', !rv.isError && Array.isArray(rv.data.trainers), rv.text?.slice(0, 200));
  }

  console.log('\n7. Duplicates and top students');
  {
    const a = await Student.create({ name: 'Twin One', roll: 'TW1', batch: da._id, semester: sem._id });
    const b = await Student.create({ name: 'Twin Onee', roll: 'TW1', batch: da._id, semester: sem._id });
    const ld = await call(cA, 'list_duplicate_students');
    ok('list_duplicate_students finds the pair', ld.data?.groups?.some(g => g.roll === 'TW1' && g.sameBatch), ld.text?.slice(0, 300));
    const m = await yes(cA, 'merge_students', { keep_student_id: String(a._id), duplicate_student_id: String(b._id) });
    ok('merge_students preview warns names differ', m.preview.data?.warnings?.some(w => /Names differ/.test(w)), m.preview.text?.slice(0, 300));
    ok('merge_students saved', m.saved.data?.saved && !(await Student.exists({ _id: b._id })), m.saved.text?.slice(0, 300));
    const top = await call(cT, 'get_top_students', {});
    const mine = (await Batch.find({ trainers: samant._id })).map(x => x.name);
    ok('get_top_students (trainer, own batches only)', !top.isError && top.data.students.length > 0 && top.data.students.every(s => mine.includes(s.batch.name)), mine);
    const rules = await yes(cA, 'set_top_student_rules', { excellent: 85 });
    ok('set_top_student_rules saved', rules.saved.data?.saved && (await call(cA, 'get_top_students', {})).data.weights.excellent === 85, rules.saved.text?.slice(0, 300));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await cA.close(); await cT.close();
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
