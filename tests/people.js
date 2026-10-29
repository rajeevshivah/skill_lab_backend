// Core people layer: linking training records → one Person per real student,
// programmes / cohorts / sections, extra profile fields, permissions, college wall.
// Real Express routes against a throwaway MongoDB.   node tests/people.js
process.env.JWT_SECRET = 'test-secret';
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const M = (n) => require('../models/' + n);
const tenant = require('../services/tenant');
const people = require('../services/people');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; fails.push(n); console.log('  FAIL', n, typeof x === 'string' ? x : JSON.stringify(x).slice(0, 400)); } };
let base;
const http = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

(async () => {
  let mongod = null;
  if (!process.env.TEST_MONGO_URI) { const { MongoMemoryServer } = require('mongodb-memory-server'); mongod = await MongoMemoryServer.create(); }
  await mongoose.connect(process.env.TEST_MONGO_URI || mongod.getUri());
  if (process.env.TEST_MONGO_URI) await mongoose.connection.dropDatabase();
  const college = await require('./college').setup();
  for (const n of ['Student', 'Person', 'Programme', 'Cohort', 'ProfileField']) await M(n).init();
  const app = express(); app.use(express.json()); app.use(require('../middleware/org').resolveOrg);
  app.use('/api/people', require('../routes/people'));
  app.use('/api/academics', require('../routes/academics'));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const T = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET);

  const admin  = await M('User').create({ name: 'Rajeev', email: 'a@x.com', password: 'longpassword1', role: 'superadmin' });
  const rohit  = await M('User').create({ name: 'Rohit', email: 'r@x.com', password: 'longpassword1', role: 'trainer' });
  const md     = await M('User').create({ name: 'MD', email: 'md@x.com', password: 'longpassword1', role: 'viewer' });
  const old = await M('Semester').create({ name: 'Even 2025-26', status: 'archived', startDate: new Date('2026-01-12') });
  const sem = await M('Semester').create({ name: 'Odd 2026-27', status: 'active', startDate: new Date('2026-07-20') });
  const DA  = await M('Batch').create({ name: 'Data Analyst', track: 'Data Analysis', semester: sem._id, trainers: [rohit._id] });
  const BD  = await M('Batch').create({ name: 'Backend Dev', track: 'Spring Boot', semester: sem._id, trainers: [rohit._id] });
  const B3  = await M('Batch').create({ name: 'BCA 3rd B', track: 'Dev Core', semester: sem._id });
  const B3A = await M('Batch').create({ name: 'BCA 3rd A', track: 'Dev Core', semester: sem._id });
  const OLD = await M('Batch').create({ name: 'BCA 2nd (old)', track: 'Dev Core', semester: old._id, isActive: false });
  const add = (b, name, roll, extra = {}) => M('Student').create({ name, roll, batch: b._id, semester: b.semester, ...extra });

  // a student in two tracks, spelt with/without the middle name and different course spellings
  const priyaDA = await add(DA, 'Priya Yadav', '12425407017', { course: 'B.Tech', sem: '3rd Sem', section: 'Sec A' });
  const priyaBD = await add(BD, 'PRIYA K. YADAV', '12425407017', { course: 'BTECH', sem: '3', section: 'a', github: 'https://github.com/priya' });
  // same person last semester too
  const ravi0 = await add(OLD, 'Ravi Kumar', '124258090300', { course: 'BCA', sem: '2nd', section: 'B' });
  const ravi1 = await add(B3, 'Ravi Kumar', '124258090300', { course: 'BCA', sem: '3rd', section: 'B' });
  // same roll, different names → doubtful
  const gov  = await add(B3A, 'Govind Kumar Saroj', '124258090166', { course: 'BCA', sem: '3rd', section: 'A' });
  const pri  = await add(B3, 'Priya Prajapati', '124258090166', { course: 'BCA', sem: '3rd', section: 'B' });
  // near roll, same name → possible same
  const sahil  = await add(B3, 'Sahil Prajapati', '124258090100', { course: 'BCA', sem: '3rd', section: 'B' });
  const sahil2 = await add(B3, 'sahil prajapati', '1242580900100', { course: 'BCA', sem: '3rd', section: 'B' });
  // two different students who share a common name, rolls far apart → NOT flagged
  await add(B3, 'Shivam Yadav', '124258090065', { course: 'BCA', sem: '3rd', section: 'B' });
  await add(B3, 'Shivam Yadav', '124258090150', { course: 'BCA', sem: '3rd', section: 'B' });
  // neighbouring rolls, same name (rolls are alphabetical) → NOT flagged
  await add(B3A, 'Khushi Singh', '12525809065', { course: 'BCA', sem: '1st', section: 'A' });
  await add(B3A, 'Khushi Singh', '12525809066', { course: 'BCA', sem: '1st', section: 'A' });
  // branch inside the course text → B.Tech + branch
  const cse = await add(BD, 'Aman Verma', '2303840100001', { course: 'B.Tech CSE(AIML)', sem: '7th', section: 'A' });
  // a self-signup copy with no course and an extra digit → possible same
  await add(B3, 'ravi kumar', '1242580903000', {});
  // temporary id, same name as a real one → possible same
  const tmp = await add(B3A, 'Anis Saroj', 'TMP-ABCDE', { rollTemporary: true, course: 'BCA', sem: '3rd', section: 'A' });
  await add(B3, 'Anis Saroj', '124258090115', { course: 'BCA', sem: '3rd', section: 'B' });
  // no course → no programme
  const nocourse = await add(DA, 'Walk In', '99999', {});
  // demo
  await add(DA, 'MD Demo Student', 'DEMO1', { demo: true, course: 'B.Tech', sem: '3' });

  // another college — must never be seen or linked
  const other = await M('Organization').create({ name: 'Other', slug: 'other-college', hosts: ['other.test'] });
  await tenant.run(other._id, async () => {
    const s2 = await M('Semester').create({ name: 'O', status: 'active', startDate: new Date('2026-07-01') });
    const b2 = await M('Batch').create({ name: 'Other batch', semester: s2._id });
    await M('Student').create({ name: 'Priya Yadav', roll: '12425407017', batch: b2._id, semester: s2._id, course: 'B.Tech', sem: '3' });
  });
  const total = await M('Student').countDocuments({}).setOptions({ withDemo: true });

  console.log('\n— Helpers');
  ok('names: middle name / case / dots match', people.sameName('Priya Yadav', 'PRIYA K. YADAV') && people.sameName('Rohit .', 'rohit'));
  ok('names: different people do not match', !people.sameName('Govind Kumar Saroj', 'Priya Prajapati') && !people.sameName('Priya', 'Priya Yadav'));
  ok('rolls: a digit added/dropped is near; a changed digit is not', people.nearRoll('1242580900100', '124258090100') && !people.nearRoll('12525809065', '12525809066') && !people.nearRoll('124258090065', '124258090150'));
  ok('course text → programme + branch', JSON.stringify(people.parseCourse('B.Tech CSE(AIML)')) === '{"programme":"BTECH","branch":"CSEAIML"}' && people.parseCourse('B.Tech Data Science').branch === 'DS' && people.parseCourse('B.Tech DS').branch === 'DS' && people.parseCourse('BCA').branch === '');
  ok('semester / section / course parsing', people.semesterNo('3rd Sem') === 3 && people.sectionCode('Sec A') === 'A' && people.sectionCode('section-b') === 'B' && people.courseCode('B.Tech') === 'BTECH');
  ok('admission year: odd 2026-27, 3rd sem → 2025; even 2025-26, 2nd sem → 2025', people.admissionYear('2026-07-20', 3) === 2025 && people.admissionYear('2026-01-12', 2) === 2025 && people.admissionYear('2026-07-20', 1) === 2026);

  console.log('\n— Plan (nothing saved)');
  let r = await http('POST', '/api/people/link', { token: T(admin), body: {} });
  const plan = r.body;
  ok('plan answers', r.status === 200 && plan.applied === false, r.body);
  ok('nothing saved by the plan', await M('Person').countDocuments({}) === 0 && await M('Programme').countDocuments({}) === 0 && !(await M('Student').exists({ person: { $ne: null } })));
  ok('only this college\'s records', plan.trainingRecords === total, plan.trainingRecords + ' vs ' + total);
  ok('two-track student = one person', plan.inSeveralBatches.some(x => x.roll === '12425407017' && x.batches.length === 2), plan.inSeveralBatches);
  ok('last semester\'s record = same person', plan.inSeveralBatches.some(x => x.roll === '124258090300' && x.batches.includes('BCA 2nd (old)')));
  ok('same roll, different names → doubtful, not merged', plan.doubtful.length === 1 && plan.doubtful[0].roll === '124258090166' && plan.doubtful[0].records.length === 2, plan.doubtful);
  ok('near roll + same name → possible same', plan.possibleSame.some(p => p.reason.includes('one character') && [...p.a, ...p.b].some(x => x.roll === '1242580900100')), plan.possibleSame);
  ok('temporary id + same name → possible same', plan.possibleSame.some(p => p.reason.includes('temporary')));
  ok('common name, far rolls → not flagged', !plan.possibleSame.some(p => [...p.a, ...p.b].some(x => x.name === 'Shivam Yadav')));
  ok('same name, neighbouring rolls → not flagged', !plan.possibleSame.some(p => [...p.a, ...p.b].some(x => x.name === 'Khushi Singh')));
  ok('copy with no course + extra digit → flagged', plan.possibleSame.some(p => [...p.a, ...p.b].some(x => x.roll === '1242580903000')));
  ok('branch from the course becomes a branch, not a programme', plan.newBranches.includes('B.Tech CSEAIML') && plan.newCohorts.includes('B.Tech CSEAIML 2023–27'), plan);
  ok('B.Tech / BTECH → one programme; BCA another', plan.newProgrammes.length === 2 && plan.newProgrammes.some(p => p.code === 'BTECH' && p.name === 'B.Tech' && p.durationYears === 4) && plan.newProgrammes.some(p => p.code === 'BCA' && p.durationYears === 3), plan.newProgrammes);
  ok('cohorts by admission year', plan.newCohorts.includes('B.Tech 2025–29') && plan.newCohorts.includes('BCA 2025–28') && plan.newCohorts.includes('BCA 2026–29') && plan.newCohorts.length === 4, plan.newCohorts);
  ok('a record with no course is reported', plan.withoutProgramme.some(x => x.name === 'Walk In'));
  const expectPeople = total - 2 /* doubtful */ - 1 /* priya 2nd record */ - 1 /* ravi old */;
  ok('people count', plan.people === expectPeople - 0 && plan.newPeople === plan.people, `${plan.people} vs ${expectPeople}`);
  ok('trainer cannot link', (await http('POST', '/api/people/link', { token: T(rohit), body: {} })).status === 403);
  ok('management cannot link', (await http('POST', '/api/people/link', { token: T(md), body: { apply: true } })).status === 403);

  console.log('\n— Apply');
  r = await http('POST', '/api/people/link', { token: T(admin), body: { apply: true } });
  ok('applied', r.status === 200 && r.body.applied && r.body.linked === r.body.recordsToLink, r.body);
  const pDA = await M('Student').findById(priyaDA._id).lean(), pBD = await M('Student').findById(priyaBD._id).lean();
  ok('both tracks point to one person', pDA.person && String(pDA.person) === String(pBD.person));
  const priya = await M('Person').findById(pDA.person).populate('academic.programme academic.cohort').lean();
  ok('person: programme, cohort, section, semester', priya.academic.programme.code === 'BTECH' && priya.academic.cohort.admissionYear === 2025 && priya.academic.section === 'A' && priya.academic.semesterNo === 3, priya.academic);
  ok('person: github carried over', priya.links.github === 'https://github.com/priya');
  const r0 = await M('Student').findById(ravi0._id).lean(), r1 = await M('Student').findById(ravi1._id).lean();
  const ravi = await M('Person').findById(r1.person).lean();
  ok('old + new semester → one person, details from the current one', String(r0.person) === String(r1.person) && ravi.academic.semesterNo === 3);
  ok('doubtful records stay unlinked', !(await M('Student').findById(gov._id)).person && !(await M('Student').findById(pri._id)).person);
  ok('possible-same made separately', String((await M('Student').findById(sahil._id)).person) !== String((await M('Student').findById(sahil2._id)).person));
  ok('temporary id kept on the person', (await M('Person').findById((await M('Student').findById(tmp._id)).person)).rollTemporary === true);
  ok('demo record → demo person', await M('Person').exists({ name: 'MD Demo Student', demo: true }));
  const amanP = await M('Person').findById((await M('Student').findById(cse._id)).person).populate('academic.programme academic.cohort').lean();
  ok('person: B.Tech + branch + branch cohort', amanP.academic.programme.code === 'BTECH' && amanP.academic.branch === 'CSEAIML' && amanP.academic.cohort.branch === 'CSEAIML' && amanP.academic.programme.branches.some(b => b.code === 'CSEAIML' && b.name === 'CSE (AI & ML)'), amanP.academic);
  const bca = await M('Cohort').findOne({ name: 'BCA 2025–28' }).lean();
  ok('cohort sections collected', bca.sections.map(s => s.code).sort().join() === 'A,B', bca.sections);
  ok('other college untouched', await tenant.run(other._id, async () => !(await M('Student').exists({ person: { $ne: null } })) && !(await M('Person').exists({}))));

  console.log('\n— Run again (safe)');
  r = await http('POST', '/api/people/link', { token: T(admin), body: {} });
  ok('nothing new to do', r.body.newPeople === 0 && r.body.recordsToLink === 0 && r.body.updatedPeople === 0 && r.body.doubtful.length === 1, r.body);
  const late = await add(DA, 'Ravi Kumar', '124258090300', { course: 'BCA', sem: '3rd', section: 'B' });   // joins a second track later
  await new Promise(r => setTimeout(r, 20));
  await M('Student').updateOne({ _id: ravi1._id }, { $set: { name: 'Ravi Kumar Singh', section: 'A' } });  // then a trainer fixes the name
  const stranger = await add(BD, 'Someone Else', '12425407017', { course: 'B.Tech', sem: '3' });           // roll of Priya, other name
  r = await http('POST', '/api/people/link', { token: T(admin), body: {} });
  ok('edited name / section → person refreshed', r.body.updatedPeople >= 1 && r.body.newPeople === 0, r.body);
  ok('new record with a known roll + name → joins the person', r.body.recordsToLink === 1);
  ok('known roll + other name → doubtful, never a 2nd person', r.body.doubtful.some(d => d.roll === '12425407017' && /priya/i.test(d.reason)), r.body.doubtful);
  r = await http('POST', '/api/people/link', { token: T(admin), body: { apply: true } });
  ok('late record linked to the same person', String((await M('Student').findById(late._id)).person) === String(ravi._id));
  ok('person refreshed', (await M('Person').findById(ravi._id)).name === 'Ravi Kumar Singh');
  ok('stranger not linked', !(await M('Student').findById(stranger._id)).person);

  console.log('\n— Merge a doubtful group (admin decides)');
  r = await http('POST', '/api/people/link', { token: T(admin), body: { merge: [[String(gov._id), String(priyaDA._id)]] } });
  ok('cannot merge an already-linked record', r.status === 400 && /already linked/.test(r.body.message), r.body);
  r = await http('POST', '/api/people/link', { token: T(admin), body: { merge: [['0123456789abcdef01234567', String(gov._id)]] } });
  ok('unknown id refused', r.status === 400);
  r = await http('POST', '/api/people/link', { token: T(admin), body: { apply: true, merge: [[String(gov._id), String(pri._id)]] } });
  ok('merged into one person when told', r.status === 200 && String((await M('Student').findById(gov._id)).person) === String((await M('Student').findById(pri._id)).person), r.body);

  console.log('\n— People list / one person');
  r = await http('GET', '/api/people?q=priya', { token: T(md) });
  ok('management can read', r.status === 200 && r.body.people.some(p => p.roll === '12425407017' && p.batches.length === 2), r.body);
  ok('demo people hidden from the list', !(await http('GET', '/api/people?q=demo', { token: T(admin) })).body.people.length);
  ok('trainer cannot read people (yet)', (await http('GET', '/api/people', { token: T(rohit) })).status === 403);
  ok('unlinked count', (await http('GET', '/api/people', { token: T(admin) })).body.unlinkedTrainingRecords === 1);
  r = await http('GET', `/api/people?cohort=${bca._id}&section=B`, { token: T(admin) });
  ok('filter by cohort + section', r.body.people.length > 0 && r.body.people.every(p => p.cohort?.name === 'BCA 2025–28' && p.section === 'B'));
  r = await http('GET', `/api/people/${priya._id}`, { token: T(admin) });
  ok('one person with training places', r.status === 200 && r.body.places.length === 2 && r.body.places.every(p => p.semesterActive), r.body);
  r = await tenant.run(other._id, async () => null);
  ok('another college\'s id is not found', (await http('GET', `/api/people/${new mongoose.Types.ObjectId()}`, { token: T(admin) })).status === 404);

  console.log('\n— Academic structure');
  r = await http('GET', '/api/academics', { token: T(admin) });
  const btech = r.body.programmes.find(p => p.code === 'BTECH');
  ok('structure lists programmes + cohorts with counts', r.status === 200 && btech && r.body.cohorts.find(c => c.name === 'BCA 2025–28').students > 5, r.body);
  ok('trainer cannot read structure', (await http('GET', '/api/academics', { token: T(rohit) })).status === 403);
  r = await http('POST', '/api/academics/programmes', { token: T(admin), body: { code: 'bca', name: 'BCA again' } });
  ok('duplicate programme code refused', r.status === 400);
  r = await http('POST', '/api/academics/programmes', { token: T(admin), body: { code: 'MCA', name: 'MCA', level: 'pg', durationYears: 2 } });
  ok('add programme', r.status === 201 && r.body.programme.code === 'MCA');
  ok('management cannot add', (await http('POST', '/api/academics/programmes', { token: T(md), body: { code: 'MBA', name: 'MBA' } })).status === 403);
  r = await http('PATCH', `/api/academics/programmes/${btech._id}`, { token: T(admin), body: { branches: [{ code: 'cse', name: 'Computer Science' }, { code: 'AIML', name: 'AI & ML' }, { code: 'CSEAIML', name: 'CSE (AI & ML)' }], aliases: ['B TECH'] } });
  ok('branches + aliases', r.status === 200 && r.body.programme.branches.length === 3 && r.body.programme.branches[0].code === 'CSE' && r.body.programme.aliases[0] === 'BTECH', r.body);
  r = await http('PATCH', `/api/academics/programmes/${btech._id}`, { token: T(admin), body: { branches: [{ code: 'CSE', name: 'x' }, { code: 'CSE', name: 'y' }] } });
  ok('branch listed twice refused', r.status === 400);
  r = await http('POST', '/api/academics/cohorts', { token: T(admin), body: { programme: btech._id, branch: 'CSE', admissionYear: 2024, sections: ['A', 'b'] } });
  ok('add cohort with branch + sections, name made', r.status === 201 && r.body.cohort.name === 'B.Tech CSE 2024–28' && r.body.cohort.sections[1].code === 'B', r.body);
  const cse24 = r.body.cohort;
  ok('same cohort twice refused', (await http('POST', '/api/academics/cohorts', { token: T(admin), body: { programme: btech._id, branch: 'CSE', admissionYear: 2024 } })).status === 400);
  ok('unknown branch refused', (await http('POST', '/api/academics/cohorts', { token: T(admin), body: { programme: btech._id, branch: 'ECE', admissionYear: 2024 } })).status === 400);

  console.log('\n— Update a person');
  const P = (body) => http('PATCH', `/api/people/${priya._id}`, { token: T(admin), body });
  ok('name / roll change refused here', (await P({ name: 'X' })).status === 400);
  ok('trainer cannot update', (await http('PATCH', `/api/people/${priya._id}`, { token: T(rohit), body: { status: 'left' } })).status === 403);
  ok('management cannot update', (await http('PATCH', `/api/people/${priya._id}`, { token: T(md), body: { status: 'left' } })).status === 403);
  ok('cohort of another programme refused', (await P({ cohort: bca._id })).status === 400);
  ok('unknown branch refused', (await P({ branch: 'ECE' })).status === 400);
  r = await P({ branch: 'cse', cohort: cse24._id, section: 'B', status: 'yearBack', entry: 'lateral', ids: [{ type: 'apaar', value: ' 123456789012 ' }],
    contact: { email: 'Priya@Mail.com', phone: '9000000000' }, links: { linkedin: 'https://linkedin.com/in/priya' } });
  ok('place, status, ids, contact, links saved', r.status === 200 && r.body.person.academic.branch === 'CSE' && r.body.person.academic.section === 'B' && r.body.person.status === 'yearBack'
    && r.body.person.ids[0].value === '123456789012' && r.body.person.contact.email === 'priya@mail.com', r.body);
  ok('section not in cohort refused', (await P({ section: 'Z' })).status === 400);
  ok('bad link refused', (await P({ links: { github: 'not a link' } })).status === 400);
  ok('bad email refused', (await P({ contact: { email: 'nope' } })).status === 400);
  ok('bad status refused', (await P({ status: 'expelled' })).status === 400);
  r = await http('PATCH', `/api/academics/cohorts/${cse24._id}`, { token: T(admin), body: { sections: ['A'] } });
  ok('section with students cannot be removed', r.status === 400 && /section B/.test(r.body.message), r.body);
  r = await http('PATCH', `/api/academics/programmes/${btech._id}`, { token: T(admin), body: { branches: [{ code: 'AIML', name: 'AI & ML' }, { code: 'CSEAIML', name: 'x' }] } });
  ok('branch with students cannot be removed', r.status === 400);
  ok('switching it off is fine', (await http('PATCH', `/api/academics/cohorts/${cse24._id}`, { token: T(admin), body: { sections: ['A', { code: 'B', isActive: false }] } })).status === 200);

  console.log('\n— Extra profile fields');
  const F = (body) => http('POST', '/api/people/fields', { token: T(admin), body });
  ok('choice field without options refused', (await F({ key: 'city', label: 'City', type: 'select' })).status === 400);
  ok('bad key refused', (await F({ key: '10th', label: '10th %', type: 'number' })).status === 400);
  r = await F({ key: 'tenth_percent', label: '10th %', type: 'number', min: 0, max: 100, group: 'Academics', editableBy: 'student', needsVerification: true });
  ok('number field added', r.status === 201);
  const tenth = r.body.field;
  await F({ key: 'pref_city', label: 'Preferred city', type: 'multiselect', options: ['Noida', 'Pune', 'Bengaluru'] });
  await F({ key: 'passport', label: 'Has passport', type: 'boolean' });
  ok('same key twice refused', (await F({ key: 'tenth_percent', label: 'Again' })).status === 400);
  ok('trainer cannot add', (await http('POST', '/api/people/fields', { token: T(rohit), body: { key: 'x_y', label: 'x' } })).status === 403);
  ok('type cannot change', (await http('PATCH', `/api/people/fields/${tenth._id}`, { token: T(admin), body: { type: 'text' } })).status === 400);
  ok('label can change', (await http('PATCH', `/api/people/fields/${tenth._id}`, { token: T(admin), body: { label: 'Class 10 %' } })).body.field.label === 'Class 10 %');
  ok('out of range refused', (await P({ custom: { tenth_percent: 120 } })).status === 400);
  ok('option not allowed refused', (await P({ custom: { pref_city: ['Delhi'] } })).status === 400);
  ok('unknown field refused', (await P({ custom: { shoe_size: 9 } })).status === 400);
  r = await P({ custom: { tenth_percent: '86.4', pref_city: ['Pune', 'Pune', 'Noida'], passport: true } });
  ok('values saved and converted', r.status === 200 && r.body.person.custom.tenth_percent === 86.4 && r.body.person.custom.pref_city.length === 2 && r.body.person.custom.passport === true, r.body);
  r = await P({ custom: { passport: null } });
  ok('null clears one value, others stay', r.body.person.custom.passport === undefined && r.body.person.custom.tenth_percent === 86.4);
  ok('student may not fill a staff-only field', people.checkCustom([{ key: 'passport', label: 'P', type: 'boolean', editableBy: 'staff' }], { passport: true }, { asStudent: true }).errors.length === 1);
  r = await http('GET', `/api/people/${priya._id}`, { token: T(md) });
  ok('fields come with the person', r.body.fields.length === 3 && r.body.person.custom.tenth_percent === 86.4);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED:', fails.join(' | '));
  server.close(); await mongoose.disconnect(); if (mongod) await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
