// PLACEMENT module: switch, roles, companies, drives (audience + rules), what
// students see and why, profile marks (verified / not), apply / withdraw,
// files, the officer's applicants, Excel + resume downloads, importing marks,
// share link + public card, and the AI tools.   node tests/placement.js
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; fails.push(n); console.log('  FAIL', n, typeof x === 'string' ? x : JSON.stringify(x).slice(0, 400)); } };
const step = (t) => console.log('\n— ' + t);
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const EXE = 'data:application/pdf;base64,' + Buffer.from('MZ\x90\x00 not a pdf').toString('base64');

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
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
  const college = await require('./college').setup();
  for (const n of ['User', 'Person', 'Drive', 'Application', 'Company', 'ProfileField', 'Document']) await M(n).init();
  const app = require('../app');
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, { token, body, raw } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const staff = async (email) => (await http('POST', '/api/auth/login', { body: { email, password: 'longpassword1' } })).body?.token;
  const mk = (name, email, role) => M('User').create({ name, email, password: 'longpassword1', role });
  await mk('Admin', 'admin@x.com', 'superadmin'); await mk('Puja', 'puja@x.com', 'placement'); await mk('Rohit', 'rohit@x.com', 'trainer'); await mk('MD', 'md@x.com', 'viewer');
  const tAd = await staff('admin@x.com'), tPo = await staff('puja@x.com'), tTr = await staff('rohit@x.com'), tMd = await staff('md@x.com');

  // the college: B.Tech (CSE, ME) and BCA, cohorts, students
  const btech = await M('Programme').create({ name: 'B.Tech', code: 'BTECH', durationYears: 4, branches: [{ code: 'CSE', name: 'CSE' }, { code: 'ME', name: 'Mech' }] });
  const bca = await M('Programme').create({ name: 'BCA', code: 'BCA', durationYears: 3 });
  const cse23 = await M('Cohort').create({ programme: btech._id, branch: 'CSE', admissionYear: 2023, name: 'B.Tech CSE 2023–27', sections: [{ code: 'A' }] });
  const me23 = await M('Cohort').create({ programme: btech._id, branch: 'ME', admissionYear: 2023, name: 'B.Tech ME 2023–27' });
  const cse24 = await M('Cohort').create({ programme: btech._id, branch: 'CSE', admissionYear: 2024, name: 'B.Tech CSE 2024–28' });
  const bca24 = await M('Cohort').create({ programme: bca._id, admissionYear: 2024, name: 'BCA 2024–27' });
  const hash = await bcrypt.hash('student-pw1', 4);
  const person = (name, roll, prog, branch, cohort, extra = {}) => M('Person').create({ name, roll, academic: { programme: prog._id, branch, cohort: cohort._id, section: 'A', semesterNo: 7 },
    login: { passwordHash: hash, activatedAt: new Date() }, ...extra });
  const asha = await person('Asha Rai', 'C001', btech, 'CSE', cse23);                                     // CSE 2027 — will qualify
  const bala = await person('Bala Singh', 'C002', btech, 'CSE', cse23);                                   // CSE 2027 — low CGPA
  const chet = await person('Chetan', 'C003', btech, 'CSE', cse23);                                       // CSE 2027 — fills nothing
  const meera = await person('Meera', 'M001', btech, 'ME', me23);                                         // ME 2027 — not in audience
  const junior = await person('Junior', 'C101', btech, 'CSE', cse24);                                     // CSE 2028 — not in audience
  const left = await person('Left One', 'C004', btech, 'CSE', cse23, { status: 'left' });                 // left — never sees
  await person('Bca Kid', 'B001', bca, '', bca24);
  const sLogin = async (roll) => (await http('POST', '/api/student/login', { body: { roll, password: 'student-pw1' } })).body?.token;

  step('Module switch');
  ok('off by default: officer side 403', (await http('GET', '/api/placement/drives', { token: tAd })).status === 403);
  const tAsha0 = await sLogin('C001');
  ok('off by default: student side 403', (await http('GET', '/api/student/placement/drives', { token: tAsha0 })).status === 403);
  ok('student home says placement is off', (await http('GET', '/api/student/me', { token: tAsha0 })).body.modules.placement === false);
  await M('Organization').updateOne({ _id: college._id }, { $set: { 'modules.placement': true } }); require('../middleware/org').forget();
  ok('switched on', (await http('GET', '/api/placement/drives', { token: tAd })).status === 200 && (await http('GET', '/api/student/me', { token: tAsha0 })).body.modules.placement === true);

  step('Who can do what');
  ok('a trainer cannot open placement', (await http('GET', '/api/placement/drives', { token: tTr })).status === 403);
  ok('the placement officer cannot open training', (await http('GET', '/api/batches', { token: tPo })).status === 403 && (await http('GET', '/api/students?batch=x', { token: tPo })).status === 403);
  ok('the placement officer can read the student list', (await http('GET', '/api/people', { token: tPo })).status === 200);
  ok('management reads placement but cannot change it', (await http('GET', '/api/placement/drives', { token: tMd })).status === 200
    && (await http('POST', '/api/placement/companies', { token: tMd, body: { name: 'X' } })).status === 403);

  step('Setup: standard academic fields');
  let r = await http('GET', '/api/placement/setup', { token: tPo });
  ok('setup lists missing fields, programmes, passing years', r.status === 200 && r.body.standardFieldsMissing.length === 7 && r.body.passingYears.includes(2027) && r.body.programmes.length === 2, r.body);
  r = await http('POST', '/api/placement/setup/standard-fields', { token: tPo });
  ok('officer adds them', r.status === 200 && r.body.added.length === 7);
  ok('…once only', (await http('POST', '/api/placement/setup/standard-fields', { token: tPo })).body.added.length === 0);
  r = await http('GET', '/api/placement/setup', { token: tPo });
  ok('rules can use CGPA, 10th, 12th, backlogs, semester', ['cgpa', 'tenth_percent', 'twelfth_percent', 'active_backlogs', 'semesterNo'].every(k => r.body.ruleFields.some(f => f.key === k)) && !r.body.ruleFields.some(f => f.key === 'tenth_marksheet'), r.body.ruleFields);
  r = await http('POST', '/api/people/fields', { token: tPo, body: { key: 'pref_city', label: 'Preferred city', type: 'select', options: ['Noida', 'Pune'], group: 'Placement', editableBy: 'student' } });
  ok('the officer can add their own field', r.status === 201, r.body);

  step('Companies');
  r = await http('POST', '/api/placement/companies', { token: tPo, body: { name: 'TCS', website: 'https://tcs.com', contacts: [{ name: 'HR', email: 'hr@tcs.com' }] } });
  const tcs = r.body.company;
  ok('add company', r.status === 201 && tcs.contacts.length === 1);
  ok('same name refused', (await http('POST', '/api/placement/companies', { token: tPo, body: { name: 'tcs' } })).status === 400);

  step('Drives: create, check, publish');
  const D = (body) => http('POST', '/api/placement/drives', { token: tPo, body });
  const applyBy = new Date(Date.now() + 5 * 864e5).toISOString();
  ok('company needed', (await D({ title: 'GET', applyBy })).status === 400);
  ok('unknown rule field refused', (await D({ company: tcs._id, title: 'GET', applyBy, rules: [{ field: 'shoe', op: 'gte', value: 1 }] })).status === 400);
  ok('a choice question needs choices', (await D({ company: tcs._id, title: 'GET', applyBy, questions: [{ label: 'City?', type: 'select', options: ['A'] }] })).status === 400);
  const audience = { programmes: [btech._id], branches: ['cse'], passingYears: [2027] };
  const rules = [{ field: 'cgpa', op: 'gte', value: 6.5 }, { field: 'active_backlogs', op: 'lte', value: 0 }];
  r = await http('POST', '/api/placement/drives/check', { token: tPo, body: { audience, rules } });
  ok('preview counts before saving: 3 see it, all need to complete their profile', r.body.counts.visible === 3 && r.body.counts.incomplete === 3 && r.body.counts.eligible === 0, r.body);
  r = await D({ company: tcs._id, title: 'Graduate Engineer Trainee', description: 'Java, SQL', ctc: { text: '₹7 LPA', min: 7, max: 7 }, location: 'Pune', applyBy, audience, rules,
    questions: [{ key: 'relocate', label: 'Willing to relocate to Pune?', type: 'boolean', required: true }] });
  const drive = r.body.drive;
  ok('draft created with a share slug', r.status === 201 && drive.status === 'draft' && /^tcs-graduate-engineer-trainee-[a-f0-9]{4}$/.test(drive.slug) && drive.audience.branches[0] === 'CSE', r.body);
  const tAsha = await sLogin('C001'), tBala = await sLogin('C002'), tChet = await sLogin('C003'), tMeera = await sLogin('M001'), tJun = await sLogin('C101');
  ok('students do not see drafts', (await http('GET', '/api/student/placement/drives', { token: tAsha })).body.drives.length === 0);
  ok('a draft link says not open', (await http('GET', `/api/student/placement/drives/${drive.slug}`, { token: tAsha })).status === 404);
  ok('trainer cannot publish', (await http('POST', `/api/placement/drives/${drive._id}/status`, { token: tTr, body: { status: 'published' } })).status === 403);
  r = await http('POST', `/api/placement/drives/${drive._id}/status`, { token: tPo, body: { status: 'published' } });
  ok('published', r.status === 200 && r.body.drive.status === 'published' && r.body.drive.publishedAt);

  step('What students see');
  r = await http('GET', '/api/student/placement/drives', { token: tAsha });
  ok('in the audience: sees it, "complete your profile" (CGPA, backlogs missing)', r.body.drives.length === 1 && r.body.drives[0].eligibility.state === 'incomplete'
    && r.body.drives[0].eligibility.missing.join() === 'CGPA (till last semester),Active backlogs' && r.body.drives[0].isNew, r.body);
  ok('other branch does not see it', (await http('GET', '/api/student/placement/drives', { token: tMeera })).body.drives.length === 0);
  ok('other passing year does not see it', (await http('GET', '/api/student/placement/drives', { token: tJun })).body.drives.length === 0);
  r = await http('GET', `/api/student/placement/drives/${drive.slug}`, { token: tMeera });
  ok('opening the link anyway: "not open for your batch"', r.status === 200 && r.body.hidden && !r.body.drive.description, r.body);

  step('Students fill marks (not verified) — eligibility follows');
  const P = (tok, body) => http('PUT', '/api/student/profile', { token: tok, body });
  r = await P(tAsha, { custom: { cgpa: 8.2, active_backlogs: 0, tenth_percent: 88, twelfth_percent: 79 }, consent: true });
  ok('Asha fills marks', r.status === 200 && r.body.profile.custom.cgpa === 8.2 && !r.body.profile.verified.cgpa, r.body);
  await P(tBala, { custom: { cgpa: 6.1, active_backlogs: 2 }, consent: true });
  r = await http('GET', '/api/student/placement/drives', { token: tAsha });
  ok('Asha: eligible (values not verified yet, drive accepts that)', r.body.drives[0].eligibility.state === 'eligible' && r.body.drives[0].eligibility.unverified.includes('cgpa') && r.body.openForMe === 1, r.body);
  r = await http('GET', '/api/student/placement/drives', { token: tBala });
  ok('Bala: not eligible, with both reasons', r.body.drives[0].eligibility.state === 'notEligible' && r.body.drives[0].eligibility.reasons.length === 2
    && /CGPA.*6\.1.*6\.5/.test(r.body.drives[0].eligibility.reasons[0]), r.body.drives[0].eligibility);
  r = await http('GET', `/api/placement/drives/${drive._id}`, { token: tPo });
  ok('officer counts: 3 see it, 1 eligible, 1 not, 1 incomplete', r.body.counts.visible === 3 && r.body.counts.eligible === 1 && r.body.counts.notEligible === 1 && r.body.counts.incomplete === 1, r.body.counts);

  step('Files');
  const U = (tok, body) => http('POST', '/api/student/placement/documents', { token: tok, body });
  ok('a fake PDF is refused', (await U(tAsha, { kind: 'resume', name: 'cv.pdf', data: EXE })).status === 400);
  ok('a huge file is refused', (await U(tAsha, { kind: 'resume', name: 'cv.pdf', data: 'data:application/pdf;base64,' + Buffer.alloc(2.2 * 1024 * 1024, 37).toString('base64') })).status === 400);
  r = await U(tAsha, { kind: 'resume', name: 'Asha CV', data: PDF });
  const resume = r.body.document;
  ok('a real PDF is saved', r.status === 201 && resume.contentType === 'application/pdf' && resume.name === 'Asha CV.pdf', r.body);
  r = await U(tAsha, { kind: 'marksheet', name: '10th', data: PDF });
  ok('marksheet goes into the profile', (await P(tAsha, { custom: { tenth_marksheet: r.body.document.id } })).status === 200);
  ok('someone else\'s file cannot be used', (await P(tBala, { custom: { tenth_marksheet: r.body.document.id } })).status === 400);
  ok('student downloads own file', (await http('GET', `/api/student/placement/documents/${resume.id}`, { token: tAsha, raw: true })).buf.slice(0, 5).toString() === '%PDF-');
  ok('…not someone else\'s', (await http('GET', `/api/student/placement/documents/${resume.id}`, { token: tBala })).status === 404);

  step('Apply');
  const A = (tok, body, slug = drive.slug) => http('POST', `/api/student/placement/drives/${slug}/apply`, { token: tok, body });
  ok('declaration needed', /Tick/.test((await A(tAsha, { resumeId: resume.id, answers: { relocate: true } })).body.message));
  ok('required question needed', /relocate/.test((await A(tAsha, { resumeId: resume.id, declaration: true })).body.message));
  ok('resume needed', /resume/.test((await A(tAsha, { declaration: true, answers: { relocate: true } })).body.message));
  ok('not eligible → refused with the reason', /not eligible.*CGPA/i.test((await A(tBala, { declaration: true, answers: { relocate: true } })).body.message));
  ok('incomplete → refused', /Complete your profile/.test((await A(tChet, { declaration: true, answers: { relocate: true } })).body.message));
  r = await A(tAsha, { resumeId: resume.id, declaration: true, answers: { relocate: true } });
  ok('Asha applies', r.status === 201, r.body);
  ok('…only once', /already/.test((await A(tAsha, { resumeId: resume.id, declaration: true, answers: { relocate: true } })).body.message));
  const app1 = await M('Application').findOne({ person: asha._id }).lean();
  ok('snapshot keeps what she had (programme, passing year, marks, unverified list)', app1.snapshot.programme === 'B.Tech' && app1.snapshot.passingYear === 2027
    && app1.snapshot.fields.cgpa === 8.2 && app1.unverified.includes('cgpa') && app1.declaredAt, app1.snapshot);
  await P(tAsha, { custom: { cgpa: 8.5 } });
  ok('a later edit does not change what was sent', (await M('Application').findById(app1._id).lean()).snapshot.fields.cgpa === 8.2);
  r = await http('GET', `/api/student/placement/drives/${drive.slug}`, { token: tAsha });
  ok('her drive page shows she applied', r.body.application.status === 'applied' && r.body.application.resume.name === 'Asha CV.pdf' && r.body.drive.rules.length === 2, r.body);
  ok('withdraw', (await http('POST', `/api/student/placement/drives/${drive.slug}/withdraw`, { token: tAsha })).status === 200);
  ok('apply again after withdrawing', (await A(tAsha, { resumeId: resume.id, declaration: true, answers: { relocate: false } })).status === 201);

  step('Officer: applicants, verify, downloads');
  r = await http('GET', `/api/placement/drives/${drive._id}/applicants`, { token: tPo });
  const a1 = r.body.applicants[0];
  ok('applicants with snapshot, answers, resume, still eligible, not verified yet', r.body.applicants.length === 1 && a1.answers.relocate === false && a1.resume.name
    && a1.now.state === 'eligible' && a1.now.unverified.join() === 'cgpa,active_backlogs', a1);
  ok('a trainer cannot verify', (await http('POST', '/api/placement/verify', { token: tTr, body: { personId: asha._id, keys: ['cgpa'] } })).status === 403);
  ok('cannot verify an empty value', (await http('POST', '/api/placement/verify', { token: tPo, body: { personId: chet._id, keys: ['cgpa'] } })).status === 400);
  r = await http('POST', '/api/placement/verify', { token: tPo, body: { personId: asha._id, keys: ['cgpa', 'active_backlogs'] } });
  ok('officer verifies Asha\'s CGPA + backlogs', r.status === 200 && r.body.verified.includes('cgpa'));
  ok('…the applicant list shows it', (await http('GET', `/api/placement/drives/${drive._id}/applicants`, { token: tPo })).body.applicants[0].now.unverified.length === 0);
  r = await P(tAsha, { custom: { cgpa: 8.6 } });
  ok('she changes her CGPA → not verified any more', !r.body.profile.verified.cgpa && r.body.profile.verified.active_backlogs);
  r = await http('GET', `/api/placement/drives/${drive._id}/export.csv`, { token: tPo, raw: true });
  const text = r.buf.toString('utf8');
  ok('Excel list: header, Asha, her answer, "not yet verified"', r.status === 200 && /text\/csv/.test(r.type) && text.startsWith('﻿#,Name,Roll') && /Asha Rai,C001,B\.Tech,CSE/.test(text)
    && /Willing to relocate to Pune\?/.test(text) && /CGPA \(till last semester\)/.test(text), text.slice(0, 400));
  r = await http('GET', `/api/placement/drives/${drive._id}/resumes.zip`, { token: tPo, raw: true });
  ok('resume zip', r.status === 200 && r.buf.readUInt32LE(0) === 0x04034b50 && r.buf.includes(Buffer.from('001 Asha Rai C001.pdf')), r.type);
  ok('management can download, a trainer cannot', (await http('GET', `/api/placement/drives/${drive._id}/export.csv`, { token: tMd, raw: true })).status === 200
    && (await http('GET', `/api/placement/drives/${drive._id}/export.csv`, { token: tTr, raw: true })).status === 403);
  ok('officer opens a resume', (await http('GET', `/api/placement/documents/${resume.id}`, { token: tPo, raw: true })).buf.slice(0, 5).toString() === '%PDF-');

  step('Verified-only drives');
  r = await D({ company: tcs._id, title: 'Strict role', applyBy, audience, rules: [{ field: 'cgpa', op: 'gte', value: 6 }], verifiedOnly: true, resumeRequired: false });
  const strict = r.body.drive;
  await http('POST', `/api/placement/drives/${strict._id}/status`, { token: tPo, body: { status: 'published' } });
  r = await http('GET', `/api/student/placement/drives/${strict.slug}`, { token: tAsha });
  ok('unverified CGPA → "needs verification"', r.body.drive.eligibility.state === 'needsVerification', r.body.drive.eligibility);
  ok('…cannot apply yet', /verified/.test((await A(tAsha, { declaration: true }, strict.slug)).body.message));
  await http('POST', '/api/placement/verify', { token: tPo, body: { personId: asha._id, keys: ['cgpa'] } });
  ok('after verifying → can apply (no resume needed here)', (await A(tAsha, { declaration: true }, strict.slug)).status === 201);

  step('Importing marks from the college (verified)');
  const I = (body) => http('POST', '/api/placement/import', { token: tPo, body });
  ok('unknown column refused', /Unknown column/.test((await I({ rows: [{ roll: 'C002', shoe: 9 }] })).body.message));
  r = await I({ rows: [{ roll: 'c002', cgpa: 6.8, active_backlogs: 0 }, { roll: 'C003', cgpa: 12 }, { roll: 'ZZZ', cgpa: 7 }] });
  ok('preview: matched, bad value, roll not found — nothing saved', r.body.applied === false && r.body.matched === 1 && r.body.problems.length === 1 && r.body.notFound[0] === 'ZZZ'
    && (await M('Person').findById(bala._id).lean()).custom.cgpa === 6.1, r.body);
  r = await I({ rows: [{ roll: 'c002', cgpa: 6.8, active_backlogs: 0 }], apply: true });
  const b2 = await M('Person').findById(bala._id).lean();
  ok('applied: values saved AND verified', r.body.applied && b2.custom.cgpa === 6.8 && b2.verified.cgpa && b2.verified.active_backlogs, b2);
  ok('Bala is now eligible for the strict drive', (await http('GET', `/api/student/placement/drives/${strict.slug}`, { token: tBala })).body.drive.eligibility.state === 'eligible');

  step('Share link');
  r = await http('GET', `/api/placement-public/${drive.slug}`);
  ok('public card: company, role, last date — no JD, no rules', r.status === 200 && r.body.drive.company === 'TCS' && r.body.drive.title && !r.body.drive.description && !r.body.drive.rules, r.body);
  await http('PATCH', `/api/placement/drives/${drive._id}`, { token: tPo, body: { publicPreview: false } });
  r = await http('GET', `/api/placement-public/${drive.slug}`);
  ok('public preview off → only "open"', r.status === 200 && !r.body.drive.company && r.body.drive.open === true, r.body);
  ok('a draft has no public card', (await http('GET', '/api/placement-public/nope-1234')).status === 404);
  const before = (await M('Drive').findById(drive._id).lean()).opens;
  await http('GET', `/api/student/placement/drives/${drive.slug}?src=share`, { token: tBala });
  ok('opening the shared link is counted', (await M('Drive').findById(drive._id).lean()).opens === before + 1);

  step('Closing');
  await http('POST', `/api/placement/drives/${drive._id}/status`, { token: tPo, body: { status: 'closed' } });
  ok('closed → no more applications', /closed/.test((await A(tBala, { declaration: true, answers: { relocate: true }, resumeId: resume.id })).body.message));
  ok('…the student who applied still sees it', (await http('GET', '/api/student/placement/drives', { token: tAsha })).body.drives.some(d => d.slug === drive.slug && d.application?.status === 'applied'));
  ok('…others do not', !(await http('GET', '/api/student/placement/drives', { token: tChet })).body.drives.some(d => d.slug === drive.slug));
  ok('cannot go back to draft once students applied', (await http('POST', `/api/placement/drives/${drive._id}/status`, { token: tPo, body: { status: 'draft' } })).status === 400);
  ok('a student who left never sees drives', (await http('GET', '/api/student/placement/drives', { token: await sLogin('C004') })).body.drives.length === 0);

  step('AI tools');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const tok = async (t) => (await http('POST', '/api/tokens', { token: t, body: { name: 'ai' } })).body.token;
  const connect = async (t) => { const c = new Client({ name: 't', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${t}` } } })); return c; };
  const call = async (c, name, args = {}) => { const x = await c.callTool({ name, arguments: args }); return { isError: !!x.isError, data: x.structuredContent, text: x.content?.[0]?.text }; };
  const cPo = await connect(await tok(tPo)), cTr = await connect(await tok(tTr)), cAd = await connect(await tok(tAd));
  const poNames = (await cPo.listTools()).tools.map(t => t.name), trNames = (await cTr.listTools()).tools.map(t => t.name), adNames = (await cAd.listTools()).tools.map(t => t.name);
  ok('placement officer sees only placement tools (+ whoami)', poNames.length === 12 && poNames.includes('save_drive') && poNames.includes('whoami') && !poNames.includes('list_batches'), poNames);
  ok('trainer sees no placement tools', !trNames.some(n => ['save_drive', 'list_drives'].includes(n)));
  ok('admin sees both', adNames.includes('save_drive') && adNames.includes('list_batches'));
  ok('placement officer cannot call a training tool', (await call(cPo, 'list_batches')).isError);
  const p1 = await call(cPo, 'save_drive', { company_id: String(tcs._id), title: 'Data Analyst', apply_by: '2099-12-31', description: 'SQL, Excel', ctc_text: '₹5 LPA', ctc_min: 5,
    branches: ['CSE'], passing_years: [2027], rules: [{ field: 'cgpa', op: 'gte', value: 7 }] });
  ok('save_drive preview: counts, nothing saved', p1.data?.mode === 'preview' && p1.data.changes.studentsWhoWouldSeeIt.visible === 3 && !(await M('Drive').exists({ title: 'Data Analyst' })), p1.text?.slice(0, 300));
  const s1 = await call(cPo, 'save_drive', { company_id: String(tcs._id), title: 'Data Analyst', apply_by: '2099-12-31', description: 'SQL, Excel', ctc_text: '₹5 LPA', ctc_min: 5,
    branches: ['CSE'], passing_years: [2027], rules: [{ field: 'cgpa', op: 'gte', value: 7 }], confirm: true, preview_token: p1.data.preview_token });
  const da = await M('Drive').findOne({ title: 'Data Analyst' }).lean();
  ok('…confirmed: draft saved, last date = end of that day in India', s1.data?.saved && da.status === 'draft' && da.applyBy.toISOString() === '2099-12-31T18:29:00.000Z', s1.text?.slice(0, 300));
  const pub1 = await call(cPo, 'set_drive_status', { drive_id: String(da._id), status: 'published' });
  const pub2 = await call(cPo, 'set_drive_status', { drive_id: String(da._id), status: 'published', confirm: true, preview_token: pub1.data.preview_token });
  ok('publish returns the share link + WhatsApp message', pub2.data?.saved && /\/d\/tcs-data-analyst-/.test(pub2.data.share.link) && /TCS is hiring — Data Analyst/.test(pub2.data.share.message), pub2.text?.slice(0, 300));
  const im = await call(cPo, 'import_marks', { rows: [{ roll: 'C003', cgpa: 7.5, active_backlogs: 0 }] });
  ok('import_marks preview', im.data?.mode === 'preview' && im.data.changes.matched === 1);
  const la = await call(cPo, 'list_applicants', { drive_id: String(strict._id) });
  ok('list_applicants', la.data?.applicants?.length === 1 && la.data.applicants[0].person.name === 'Asha Rai', la.text?.slice(0, 200));
  await cPo.close(); await cTr.close(); await cAd.close();
  await new Promise(r => setTimeout(r, 500));   // let the AI-tool audit rows finish writing

  step('Branches narrow only their own programme');
  {
    const E = require('../services/eligibility');
    const ctx = { prog: new Map([['b', { durationYears: 4, branches: [{ code: 'CSE' }, { code: 'ME' }] }], ['c', { durationYears: 3, branches: [] }]]),
      cohort: new Map([['cb', { admissionYear: 2023 }], ['cc', { admissionYear: 2024 }]]), field: new Map() };
    const d = { audience: { programmes: ['b', 'c'], branches: ['CSE'], passingYears: [2027] } };
    const P = (prog, branch, cohort) => ({ academic: { programme: prog, branch, cohort } });
    ok('B.Tech CSE + BCA: a BCA final-year student sees it', E.inAudience(d, P('c', '', 'cc'), ctx));
    ok('B.Tech CSE + BCA: a B.Tech CSE student sees it', E.inAudience(d, P('b', 'CSE', 'cb'), ctx));
    ok('B.Tech CSE + BCA: a B.Tech ME student does not', !E.inAudience(d, P('b', 'ME', 'cb'), ctx));
    ok('B.Tech CSE + BCA: a B.Tech student with no branch does not', !E.inAudience(d, P('b', '', 'cb'), ctx));
    ok('CSE alone (no programme picked): a BCA student does not', !E.inAudience({ audience: { programmes: [], branches: ['CSE'], passingYears: [] } }, P('c', '', 'cc'), ctx));
  }

  step('Every query works on real MongoDB');
  ok('no query asks for a path and its parent together', collisions.length === 0, [...new Set(collisions)]);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED:', fails.join(' | '));
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
