// MCP integration test — runs the real Express app (tokens + /mcp) against a
// throwaway MongoDB, then connects with the OFFICIAL MCP client, exactly like
// Claude / Cursor would.
//
//   npm run test:mcp
//
// Never touches your Atlas database.
process.env.JWT_SECRET = 'test-secret';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const User      = require('../models/User');
const Semester  = require('../models/Semester');
const Batch     = require('../models/Batch');
const Student   = require('../models/Student');
const Cycle     = require('../models/Cycle');
const CycleMark = require('../models/CycleMark');
const CyclePlan = require('../models/CyclePlan');
const DailyLog  = require('../models/DailyLog');
const Plan      = require('../models/Plan');
const ApiToken  = require('../models/ApiToken');
const McpAuditLog = require('../models/McpAuditLog');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); } };

let base;
const http = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

async function connect(mcpToken) {
  const client = new Client({ name: 'skilllab-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
  });
  await client.connect(transport);
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent, text: r.content?.[0]?.text };
};

(async () => {
  // TEST_MONGO_URI lets you point at a separate, disposable test database
  // instead of the auto-downloaded one. NEVER point it at your real Atlas DB.
  const mongod = process.env.TEST_MONGO_URI ? null : await MongoMemoryServer.create();
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const college = await require('./college').setup();

  const app = express();
  app.use(express.json());
  app.use('/api/tokens', require('../routes/tokens'));
  app.use('/mcp', require('../mcp'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  // ── fixtures ──
  const admin   = await User.create({ name: 'Rajeev', email: 'admin@x.com', password: 'longpassword1', role: 'superadmin' });
  const lucky   = await User.create({ name: 'Lucky',  email: 'lucky@x.com', password: 'longpassword1', role: 'trainer' });
  const deepu   = await User.create({ name: 'Deepu',  email: 'deepu@x.com', password: 'longpassword1', role: 'trainer' });
  const sem     = await Semester.create({ name: 'Odd 2026', status: 'active' });
  const mern    = await Batch.create({ name: 'MERN Track', track: 'MERN', semester: sem._id, trainers: [lucky._id] });
  const bca     = await Batch.create({ name: 'BCA 3 A', track: 'C++', semester: sem._id, trainers: [deepu._id] });
  await Plan.create({ batch: mern._id, semester: sem._id, topics: [{ title: 'useState', order: 1 }, { title: 'Express', order: 2 }] });
  const s1 = await Student.create({ name: 'Aman',  roll: '101', batch: mern._id, semester: sem._id });
  const s2 = await Student.create({ name: 'Bhavna', roll: '102', batch: mern._id, semester: sem._id });
  const s3 = await Student.create({ name: 'Chetan', roll: '103', batch: mern._id, semester: sem._id });
  const s4 = await Student.create({ name: 'Divya', roll: '201', batch: bca._id,  semester: sem._id });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cycle = await Cycle.create({ batch: mern._id, semester: sem._id, number: 1,
    startDate: new Date(today.getTime() - 10 * 86400000), endDate: new Date(today.getTime() + 4 * 86400000) });
  await CycleMark.create({ cycle: cycle._id, batch: mern._id, semester: sem._id, student: s1._id, status: 'evaluated', assessment: 80, project: 75, category: 'excellent' });
  await CycleMark.create({ cycle: cycle._id, batch: mern._id, semester: sem._id, student: s2._id, status: 'evaluated', assessment: 0, project: 0, category: 'zero' });
  // s3 has no mark row → not-evaluated
  await CyclePlan.create({ cycle: cycle._id, batch: mern._id, semester: sem._id,
    classes: [{ number: 1, title: 'Intro to hooks', date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}` }] });
  await DailyLog.create({ batch: mern._id, semester: sem._id, date: today, notes: 'useState demo', attendanceTaken: true,
    attendance: [{ student: s1._id, present: true }, { student: s2._id, present: false }, { student: s3._id, present: true }] });
  await Student.updateMany({ batch: mern._id }, { 'stats.totalSessions': 1 });
  await Student.updateOne({ _id: s1._id }, { 'stats.presentCount': 1 });

  const jwtFor = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);

  console.log('\n1. Token management (website login required)');
  ok('GET /api/tokens without login → 401', (await http('GET', '/api/tokens')).status === 401);
  ok('create without name → 400', (await http('POST', '/api/tokens', { token: jwtFor(lucky), body: {} })).status === 400);
  const created = await http('POST', '/api/tokens', { token: jwtFor(lucky), body: { name: 'Lucky Claude', expiresInDays: 90 } });
  ok('create token → 201', created.status === 201, JSON.stringify(created.body));
  const LUCKY = created.body.token;
  ok('plain token starts with slmcp_', /^slmcp_/.test(LUCKY));
  ok('mcpUrl returned', /\/mcp$/.test(created.body.mcpUrl));
  const stored = await ApiToken.findOne({ user: lucky._id });
  ok('token stored as hash only (never plain)', stored.hash !== LUCKY && !JSON.stringify(stored.toObject()).includes(LUCKY));
  const list = await http('GET', '/api/tokens', { token: jwtFor(lucky) });
  ok('list shows token, no secret', list.body.tokens.length === 1 && !JSON.stringify(list.body).includes(LUCKY));
  ok('bad expiry rejected', (await http('POST', '/api/tokens', { token: jwtFor(lucky), body: { name: 'x', expiresInDays: 7 } })).status === 400);
  const ADMIN = (await http('POST', '/api/tokens', { token: jwtFor(admin), body: { name: 'Rajeev Claude' } })).body.token;
  const DEEPU = (await http('POST', '/api/tokens', { token: jwtFor(deepu), body: { name: 'Deepu', expiresInDays: 0 } })).body.token;
  ok('Deepu cannot revoke Lucky\'s token', (await http('DELETE', `/api/tokens/${stored._id}`, { token: jwtFor(deepu) })).status === 404);

  console.log('\n2. /mcp rejects bad credentials');
  const mcpHeaders = { Accept: 'application/json, text/event-stream' };
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  ok('no token → 401', (await http('POST', '/mcp', { body: init, headers: mcpHeaders })).status === 401);
  ok('website JWT is NOT accepted → 401', (await http('POST', '/mcp', { token: jwtFor(admin), body: init, headers: mcpHeaders })).status === 401);
  ok('made-up token → 401', (await http('POST', '/mcp', { token: 'slmcp_fake', body: init, headers: mcpHeaders })).status === 401);
  ok('GET /mcp → 405 (stateless)', (await http('GET', '/mcp', { token: LUCKY })).status === 405);

  console.log('\n3. Official MCP client connects and lists tools');
  const cL = await connect(LUCKY);
  const { tools } = await cL.listTools();
  const names = tools.map(t => t.name).sort();
  ok('trainer sees 36 tools', names.length === 36, names.join(','));
  const READ = ['whoami','search','list_batches','get_batch_roster','list_cycles','get_cycle_marks','get_cycle_plan','get_daily_logs','get_student_profile','get_today_overview','get_hall_of_fame'];
  ok('all 11 read tools marked read-only', READ.every(n => tools.find(t => t.name === n)?.annotations?.readOnlyHint === true));
  ok('server instructions sent', /Skill Lab/.test(cL.getInstructions() || ''));

  console.log('\n4. Trainer scoping — Lucky sees MERN only');
  const who = await call(cL, 'whoami');
  ok('whoami = Lucky / trainer', who.data.user.name === 'Lucky' && who.data.user.role === 'trainer');
  ok('whoami lists only MERN', who.data.batches.length === 1 && who.data.batches[0].name === 'MERN Track');
  const lb = await call(cL, 'list_batches');
  ok('list_batches → only MERN, 3 students', lb.data.batches.length === 1 && lb.data.batches[0].students === 3);
  const blocked = await call(cL, 'get_batch_roster', { batch_id: String(bca._id) });
  ok('Lucky reading BCA roster → refused', blocked.isError && /not assigned/.test(blocked.text));
  const srch = await call(cL, 'search', { query: 'Divya' });
  ok('search does not leak other batch students', srch.data.students.length === 0);
  const prof = await call(cL, 'get_student_profile', { roll: '201' });
  ok('profile of other batch student → refused', prof.isError);
  const badId = await call(cL, 'get_batch_roster', { batch_id: 'nonsense' });
  ok('invalid id → friendly error', badId.isError && /not a valid batch id/.test(badId.text));

  console.log('\n5. Data is correct');
  const roster = await call(cL, 'get_batch_roster', { batch_id: String(mern._id) });
  ok('roster has 3 students', roster.data.total === 3);
  ok('Aman attendance 100%', roster.data.students.find(s => s.roll === '101').attendancePct === 100);
  const low = await call(cL, 'get_batch_roster', { batch_id: String(mern._id), max_attendance_pct: 50 });
  ok('low-attendance filter → 2 students', low.data.total === 2);
  const marks = await call(cL, 'get_cycle_marks', { cycle_id: String(cycle._id) });
  const st = Object.fromEntries(marks.data.rows.map(r => [r.roll, r.state]));
  ok('Aman evaluated, Bhavna zero, Chetan not-evaluated', st['101'] === 'evaluated' && st['102'] === 'zero' && st['103'] === 'not-evaluated');
  ok('not-evaluated has total null (not 0)', marks.data.rows.find(r => r.roll === '103').total === null);
  ok('average excludes not-evaluated: (155+0)/2 = 77.5', marks.data.summary.averageScore === 77.5 && marks.data.summary.outOf === 200);
  ok('suggested top3 excludes zero', marks.data.summary.suggestedTop3.length === 1 && marks.data.summary.suggestedTop3[0].roll === '101');
  ok('cycle attendance uses batch sessions', marks.data.rows.find(r => r.roll === '102').attendancePct === 0 && marks.data.summary.sessionsInCycle === 1);
  const zeroOnly = await call(cL, 'get_cycle_marks', { cycle_id: String(cycle._id), state: 'zero' });
  ok('filter by state works', zeroOnly.data.rows.length === 1 && zeroOnly.data.rows[0].roll === '102');
  const plan = await call(cL, 'get_cycle_plan', { cycle_id: String(cycle._id) });
  ok('cycle plan + logged-today check', plan.data.classes[0].title === 'Intro to hooks' && plan.data.classes[0].logged === true);
  const logs = await call(cL, 'get_daily_logs', { batch_id: String(mern._id), include_absentees: true });
  ok('daily log: 2 present, 1 absent (Bhavna)', logs.data.logs[0].present === 2 && logs.data.logs[0].absentees[0].roll === '102');
  const p = await call(cL, 'get_student_profile', { roll: '101' });
  ok('profile history baseline = excellent', p.data.students[0].baseline.category === 'excellent');
  const ov = await call(cL, 'get_today_overview');
  ok('today overview: MERN logged today', ov.data.batches.length === 1 && ov.data.batches[0].loggedToday === true);
  const cyc = await call(cL, 'search', { query: 'cycle 1' });
  ok('search "cycle 1" finds the cycle', cyc.data.cycles.length === 1);
  await cL.close();

  console.log('\n6. Superadmin sees everything');
  const cA = await connect(ADMIN);
  ok('admin list_batches → 2', (await call(cA, 'list_batches')).data.batches.length === 2);
  ok('admin can read BCA roster', !(await call(cA, 'get_batch_roster', { batch_id: String(bca._id) })).isError);
  await cA.close();
  const cD = await connect(DEEPU);
  ok('Deepu cannot read MERN marks', (await call(cD, 'get_cycle_marks', { cycle_id: String(cycle._id) })).isError);
  await cD.close();

  console.log('\n7. Audit log + revoke');
  await new Promise(r => setTimeout(r, 200));
  const audit = await McpAuditLog.find({ user: lucky._id });
  ok('Lucky\'s tool calls were audited', audit.length >= 10);
  ok('refused calls audited as failed', audit.some(a => a.tool === 'get_batch_roster' && !a.ok));
  const act = await http('GET', '/api/tokens/activity', { token: jwtFor(lucky) });
  ok('activity endpoint shows only own rows', act.body.activity.length > 0 && act.body.activity.every(a => a.user === 'Lucky'));
  const actA = await http('GET', '/api/tokens/activity', { token: jwtFor(admin) });
  ok('superadmin activity sees everyone', new Set(actA.body.activity.map(a => a.user)).size >= 2);
  ok('revoke → 200', (await http('DELETE', `/api/tokens/${stored._id}`, { token: jwtFor(lucky) })).status === 200);
  ok('revoked token → 401', (await http('POST', '/mcp', { token: LUCKY, body: init, headers: mcpHeaders })).status === 401);
  await User.updateOne({ _id: deepu._id }, { isActive: false });
  ok('deactivated user\'s token → 401', (await http('POST', '/mcp', { token: DEEPU, body: init, headers: mcpHeaders })).status === 401);
  await ApiToken.updateOne({ user: admin._id }, { expiresAt: new Date(Date.now() - 1000) });
  ok('expired token → 401', (await http('POST', '/mcp', { token: ADMIN, body: init, headers: mcpHeaders })).status === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
