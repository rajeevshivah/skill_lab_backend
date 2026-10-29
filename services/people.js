// ─────────────────────────────────────────────────────────────────────
//  People: one Person per real student per college (models/Person.js),
//  made from today's training records (models/Student.js — one per batch).
//
//  link()  — PLAN (nothing saved) or APPLY:
//    • training records with the same roll + matching name → ONE person
//      (a student in two tracks, or in last semester's batch too)
//    • same roll, names that do NOT match → "doubtful": left unlinked until
//      someone decides (fix the roll, or say they are the same → merge)
//    • a temporary/near-identical roll with the same name → "possible same"
//      warning (made separately, check them)
//    • programmes (from the course text) and cohorts (programme + admission
//      year, worked out from the semester) are created as needed
//  Safe to run again: already-linked records keep their person, and the
//  person's copied name / roll / place are refreshed from the latest record.
// ─────────────────────────────────────────────────────────────────────
const Student   = require('../models/Student');
const Batch     = require('../models/Batch');
const Semester  = require('../models/Semester');
const Person    = require('../models/Person');
const Programme = require('../models/Programme');
const Cohort    = require('../models/Cohort');
const tempRoll  = require('./tempRoll');

// ── normalising ──────────────────────────────────────────────────────

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => normName(s).split(' ').filter(Boolean);

// Same person by name? Exact (ignoring case, dots, spaces), or one name is the
// other with a middle name added/dropped ("Sakshi Yadav" ~ "Sakshi C. Yadav").
function sameName(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  if (x.length === 1 || y.length === 1) return false;
  return x[0] === y[0] && x[x.length - 1] === y[y.length - 1];
}

const normRoll = (r) => String(r || '').trim().toUpperCase();

// one character added or dropped (a typo): 1242580900100 vs 124258090100.
// A changed character is NOT flagged — rolls are given alphabetically, so two
// different students with the same name often have neighbouring rolls (…065, …066).
function nearRoll(a, b) {
  if (!a || !b || Math.abs(a.length - b.length) !== 1) return false;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

// Known programmes: code → defaults. Anything else becomes its own programme.
const KNOWN = {
  BTECH: { name: 'B.Tech', level: 'ug', durationYears: 4 },
  BE:    { name: 'B.E.',   level: 'ug', durationYears: 4 },
  BCA:   { name: 'BCA',    level: 'ug', durationYears: 3 },
  BBA:   { name: 'BBA',    level: 'ug', durationYears: 3 },
  BSC:   { name: 'B.Sc',   level: 'ug', durationYears: 3 },
  BCOM:  { name: 'B.Com',  level: 'ug', durationYears: 3 },
  MCA:   { name: 'MCA',    level: 'pg', durationYears: 2 },
  MBA:   { name: 'MBA',    level: 'pg', durationYears: 2 },
  MTECH: { name: 'M.Tech', level: 'pg', durationYears: 2 },
  MSC:   { name: 'M.Sc',   level: 'pg', durationYears: 2 },
  DIPLOMA: { name: 'Diploma', level: 'diploma', durationYears: 3 },
};
const courseCode = (course) => String(course || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);

// Branches: other spellings → one code, and its name.
const BRANCH_ALIAS = { DATASCIENCE: 'DS', CSEDS: 'DS', MECHANICAL: 'ME', MECH: 'ME', CIVIL: 'CE', ELECTRICAL: 'EE',
  CSAIML: 'CSEAIML', AIMLCSE: 'CSEAIML', COMPUTERSCIENCE: 'CSE', CS: 'CSE' };
const BRANCH_NAME = { CSE: 'Computer Science & Engineering', CSEAIML: 'CSE (AI & ML)', AIML: 'AI & ML', DS: 'Data Science',
  ME: 'Mechanical Engineering', EEE: 'Electrical & Electronics Engineering', EE: 'Electrical Engineering', ECE: 'Electronics & Communication',
  CE: 'Civil Engineering', IT: 'Information Technology' };
const KNOWN_BY_LENGTH = () => Object.keys(KNOWN).sort((a, b) => b.length - a.length);

// "B.Tech CSE(AIML)" → { programme: 'BTECH', branch: 'CSEAIML' }; "BCA" → { programme: 'BCA', branch: '' }
function parseCourse(course) {
  const all = courseCode(String(course || '').replace(/\s+/g, ' '));
  if (!all) return null;
  const known = KNOWN_BY_LENGTH().find(k => all.startsWith(k));
  if (!known) return { programme: all, branch: '' };
  let branch = all.slice(known.length);
  branch = BRANCH_ALIAS[branch] || branch;
  return { programme: known, branch: branch.slice(0, 20) };
}

// "3rd Sem" → 3, "1" → 1, "" → null
function semesterNo(sem) {
  const m = String(sem || '').match(/\d+/);
  const n = m ? Number(m[0]) : null;
  return n && n >= 1 && n <= 16 ? n : null;
}
// "Sec A" / "a" / "Section-B" → "A"
const sectionCode = (s) => String(s || '').toUpperCase().replace(/^\s*SEC(TION)?[\s.\-:]*/, '').replace(/[^A-Z0-9]/g, '').slice(0, 10);

// Admission year from the term the record is in and the semester number:
// odd term of 2026-27, 3rd sem → admitted 2025.
function admissionYear(termStart, semNo, termsPerYear = 2) {
  if (!termStart || !semNo) return null;
  const d = new Date(termStart);
  const academicYear = d.getUTCMonth() >= 5 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;   // June onwards = new academic year
  return academicYear - Math.floor((semNo - 1) / termsPerYear);
}
const cohortName = (prog, branch, year) =>
  `${prog.name}${branch ? ' ' + branch : ''} ${year}–${String(Math.round(year + (prog.durationYears || 4))).slice(-2)}`;

// ── profile fields (models/ProfileField.js) ──────────────────────────

// Check + convert values for the college's extra fields.
// Returns { values, errors }; unknown keys are refused; null/'' clears a value.
function checkCustom(fields, input, { asStudent = false } = {}) {
  const byKey = new Map(fields.filter(f => f.isActive !== false).map(f => [f.key, f]));
  const values = {}, errors = [];
  for (const [key, raw] of Object.entries(input || {})) {
    const f = byKey.get(key);
    if (!f) { errors.push(`"${key}" is not a profile field of this college.`); continue; }
    if (asStudent && f.editableBy !== 'student') { errors.push(`${f.label} can only be filled by staff.`); continue; }
    if (raw === null || raw === '') { values[key] = null; continue; }
    let v = raw;
    switch (f.type) {
      case 'number':
        v = Number(raw);
        if (!Number.isFinite(v)) { errors.push(`${f.label} must be a number.`); continue; }
        if (f.min != null && v < f.min) { errors.push(`${f.label} must be at least ${f.min}.`); continue; }
        if (f.max != null && v > f.max) { errors.push(`${f.label} must be at most ${f.max}.`); continue; }
        break;
      case 'boolean':
        if (typeof raw !== 'boolean') { errors.push(`${f.label} must be yes or no.`); continue; }
        break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || isNaN(new Date(raw))) { errors.push(`${f.label} must be a date (YYYY-MM-DD).`); continue; }
        v = String(raw);
        break;
      case 'select':
        if (!f.options.includes(String(raw))) { errors.push(`${f.label} must be one of: ${f.options.join(', ')}.`); continue; }
        v = String(raw);
        break;
      case 'multiselect': {
        const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
        const bad = list.filter(x => !f.options.includes(x));
        if (bad.length) { errors.push(`${f.label}: ${bad.join(', ')} not allowed.`); continue; }
        v = [...new Set(list)];
        break;
      }
      case 'url':
        if (!/^https?:\/\/\S+$/i.test(String(raw)) || String(raw).length > 300) { errors.push(`${f.label} must be a web link (https://…).`); continue; }
        v = String(raw);
        break;
      default:
        v = String(raw).slice(0, 500);
    }
    values[key] = v;
  }
  return { values, errors };
}

class LinkError extends Error {}
class PeopleError extends Error { constructor(msg, status = 400, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); } }

// ── the academic structure, loaded once, grown on demand ─────────────
// programmeFor("B.Tech CSE") / cohortFor(…) return existing or NEW (unsaved)
// entries; save() writes the new ones. Used by link() and by adding students.
async function loadStructure() {
  const [programmes, cohorts, semesters] = await Promise.all([Programme.find({}).lean(), Cohort.find({}).lean(), Semester.find({}).select('startDate status').lean()]);
  const semStart = new Map(semesters.map(x => [String(x._id), x.startDate]));
  const progByCode = new Map();
  for (const p of programmes) { progByCode.set(p.code, p); for (const a of p.aliases || []) if (!progByCode.has(a)) progByCode.set(a, p); }
  const progById = new Map(programmes.map(p => [String(p._id), p]));
  const newProgrammes = [], newBranches = [], newCohorts = [];
  const programmeFor = (course) => {
    const c = parseCourse(course);
    if (!c) return null;
    let p = progByCode.get(c.programme);
    if (!p) {
      const k = KNOWN[c.programme] || { name: String(course).trim().slice(0, 80), level: 'ug', durationYears: 4 };
      p = { _id: null, code: c.programme, name: k.name, level: k.level, durationYears: k.durationYears, termsPerYear: 2, branches: [], aliases: [], _new: true };
      progByCode.set(c.programme, p); newProgrammes.push(p);
    }
    if (c.branch && !p.branches.some(b => b.code === c.branch)) {
      p.branches = [...p.branches, { code: c.branch, name: BRANCH_NAME[c.branch] || c.branch, isActive: true }];
      p._branchesChanged = true;
      newBranches.push(`${p.name} ${c.branch}`);
    }
    return { prog: p, branch: c.branch };
  };
  const cohortKey = (progCode, branch, year) => `${progCode}|${branch}|${year}`;
  const cohortBy = new Map(cohorts.map(c => [cohortKey(progById.get(String(c.programme))?.code, c.branch || '', c.admissionYear), c]));
  const cohortFor = (prog, branch, year, section) => {
    if (!prog || !year) return null;
    const k = cohortKey(prog.code, branch, year);
    let c = cohortBy.get(k);
    if (!c) { c = { _id: null, prog, branch, admissionYear: year, name: cohortName(prog, branch, year), sections: [], _new: true }; cohortBy.set(k, c); newCohorts.push(c); }
    if (section && !c.sections.some(x => x.code === section)) { c.sections = [...c.sections, { code: section, isActive: true }]; c._sectionsChanged = true; }
    return c;
  };
  // where a training record puts a NEW person: programme, branch, cohort, section, semester
  const placeOf = (rec) => {
    const pl = programmeFor(rec.course);
    const prog = pl?.prog || null, branch = pl?.branch || '';
    const semNo = semesterNo(rec.sem), section = sectionCode(rec.section);
    const cohort = cohortFor(prog, branch, admissionYear(semStart.get(String(rec.semester)), semNo, prog?.termsPerYear || 2), section);
    return { prog, branch, cohort, section, semNo };
  };
  async function save(userId) {
    for (const p of newProgrammes) {
      if (p._id) continue;
      const made = await Programme.create({ code: p.code, name: p.name, level: p.level, durationYears: p.durationYears, branches: p.branches, createdBy: userId });
      p._id = made._id; p._branchesChanged = false;
    }
    for (const p of new Set(progByCode.values())) if (p._id && p._branchesChanged) { await Programme.updateOne({ _id: p._id }, { $set: { branches: p.branches } }); p._branchesChanged = false; }
    for (const c of cohortBy.values()) {
      if (!c._id) {
        const made = await Cohort.create({ programme: c.prog._id, branch: c.branch, admissionYear: c.admissionYear, name: c.name, sections: c.sections, createdBy: userId });
        c._id = made._id; c._sectionsChanged = false;
      } else if (c._sectionsChanged) { await Cohort.updateOne({ _id: c._id }, { $set: { sections: c.sections } }); c._sectionsChanged = false; }
    }
  }
  return { semStart, placeOf, save, newProgrammes, newBranches, newCohorts };
}

// A new person's fields from a training record and its place.
const personDoc = (rec, place, userId, source = 'training') => ({
  name: rec.name, roll: rec.roll || '', rollTemporary: !!(rec.rollTemporary || tempRoll.isTemp(rec.roll)), demo: !!rec.demo, source,
  academic: { programme: place.prog?._id || null, branch: place.branch, cohort: place.cohort?._id || null, section: place.section, semesterNo: place.semNo },
  links: { github: rec.github || '' }, createdBy: userId,
});

// ── semester number from the cohort + the running term ───────────────
// odd term (June–December) of 2026-27 for a 2025 cohort → 3rd sem. Two-term programmes only.
function semesterNow(admission, termStart, prog) {
  if (!admission || !termStart || (prog?.termsPerYear || 2) !== 2) return null;
  const d = new Date(termStart);
  const odd = d.getUTCMonth() >= 5;
  const academicYear = odd ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const n = (academicYear - admission) * 2 + (odd ? 1 : 2);
  const max = Math.round((prog?.durationYears || 4) * 2);
  return n >= 1 && n <= max ? n : null;
}
// Set every studying person's semester number from their cohort and the active term.
async function recomputeSemesters() {
  const term = await Semester.findOne({ status: 'active' }).sort('-startDate').select('startDate').lean();
  if (!term?.startDate) return { updated: 0 };
  const [cohorts, programmes] = await Promise.all([Cohort.find({}).select('programme admissionYear').lean(), Programme.find({}).select('termsPerYear durationYears').lean()]);
  const prog = new Map(programmes.map(p => [String(p._id), p]));
  const ops = [];
  for (const c of cohorts) {
    const n = semesterNow(c.admissionYear, term.startDate, prog.get(String(c.programme)));
    if (n) ops.push({ updateMany: { filter: { 'academic.cohort': c._id, status: 'studying', 'academic.semesterNo': { $ne: n } }, update: { $set: { 'academic.semesterNo': n } } } });
  }
  if (!ops.length) return { updated: 0 };
  const r = await Person.bulkWrite(ops);
  return { updated: r.modifiedCount || 0 };
}

// ── link: training records → people ──────────────────────────────────

/**
 * @param {object} opts
 *   apply   — false: plan only (nothing saved)
 *   merge   — [[studentId, …], …] records the admin says ARE one person
 *             (resolves "doubtful" groups: same roll, different spelling)
 *   userId  — who is doing it
 * Already-linked people get their name / roll / demo copied from the newest
 * record; where they are (programme, cohort, section) is set only when empty —
 * after that it is managed on the person (admin, import), not by training text.
 */
async function link({ apply = false, merge = [], userId = null } = {}) {
  const [students, batches, persons, S] = await Promise.all([
    Student.find({}).select('name roll rollTemporary course sem section batch semester person demo github updatedAt').setOptions({ withDemo: true }).lean(),
    Batch.find({}).select('name').lean(),
    Person.find({}).lean(),
    loadStructure(),
  ]);
  const batchName = new Map(batches.map(b => [String(b._id), b.name]));
  const personById = new Map(persons.map(p => [String(p._id), p]));
  const ref = (s) => ({ studentId: String(s._id), name: s.name, roll: s.roll, batch: batchName.get(String(s.batch)) || '?' });

  // forced merges first (admin's decision)
  const forced = new Map();   // studentId → group no.
  const byId = new Map(students.map(s => [String(s._id), s]));
  merge.forEach((g, i) => (g || []).forEach(id => {
    const s = byId.get(String(id));
    if (!s) throw new LinkError(`No training record ${id} in this college.`);
    if (s.person) throw new LinkError(`${s.name} (${s.roll}) is already linked to a person — merge people instead.`);
    if (forced.has(String(id))) throw new LinkError(`${s.name} is in two merge groups.`);
    forced.set(String(id), i);
  }));

  const groups = new Map();   // key → [records]
  for (const s of students) {
    let key;
    if (forced.has(String(s._id))) key = `merge:${forced.get(String(s._id))}`;
    else if (s.person && personById.has(String(s.person))) key = `person:${s.person}`;   // already linked
    else if (s.roll && !s.rollTemporary && !tempRoll.isTemp(s.roll)) key = `roll:${normRoll(s.roll)}`;
    else key = `one:${s._id}`;                                            // no real roll: on their own
    (groups.get(key) || groups.set(key, []).get(key)).push(s);
  }
  // a new roll-group whose roll an existing person already has → join that person
  // (… and a different name → doubtful, never a second person with the same roll)
  const doubtful = [], plans = [];
  const personByRoll = new Map(persons.filter(p => p.roll && !p.rollTemporary).map(p => [normRoll(p.roll), p]));
  for (const [key, recs] of [...groups]) {
    if (!key.startsWith('roll:')) continue;
    const p = personByRoll.get(key.slice(5));
    if (!p) continue;
    if (recs.every(r => sameName(r.name, p.name))) {
      const k = `person:${p._id}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(...recs);
    } else {
      doubtful.push({ roll: recs[0].roll, reason: `Roll already belongs to ${p.name}, different name`, records: recs.map(ref) });
    }
    groups.delete(key);
  }

  for (const [key, recs] of groups) {
    // same roll, names that do not all match → do not guess
    if (key.startsWith('roll:') && recs.length > 1 && !recs.every(r => sameName(r.name, recs[0].name))) {
      doubtful.push({ roll: recs[0].roll, reason: 'Same roll number, different names', records: recs.map(ref) });
      continue;
    }
    // copies come from the newest record (active semester first)
    const latest = [...recs].sort((a, b) => (S.semStart.get(String(b.semester)) || 0) - (S.semStart.get(String(a.semester)) || 0)
      || new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const existing = key.startsWith('person:') ? personById.get(key.slice(7)) : null;
    const place = !existing || !existing.academic?.programme ? S.placeOf(latest) : null;
    plans.push({
      existing, recs, latest, place,
      doc: { name: latest.name, roll: latest.roll || '', rollTemporary: !!(latest.rollTemporary || tempRoll.isTemp(latest.roll)),
        demo: recs.every(r => r.demo), github: recs.map(r => r.github).find(Boolean) || '' },
    });
  }

  // possible same person made separately: same name, and one roll temporary or a character added/dropped
  const possibleSame = [];
  const byName = new Map();
  for (const p of plans.filter(x => !x.doc.demo)) { const k = normName(p.doc.name); (byName.get(k) || byName.set(k, []).get(k)).push(p); }
  for (const list of byName.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i].doc, b = list[j].doc;
      const why = a.rollTemporary || b.rollTemporary ? 'Same name, one has a temporary ID'
        : nearRoll(normRoll(a.roll), normRoll(b.roll)) ? 'Same name, roll numbers one character apart' : null;
      if (why) possibleSame.push({ reason: why, a: list[i].recs.map(ref), b: list[j].recs.map(ref) });
    }
  }

  const changes = (p) => {
    const e = p.existing, set = {};
    if (!e) return set;
    if (e.name !== p.doc.name) set.name = p.doc.name;
    if ((e.roll || '') !== p.doc.roll) set.roll = p.doc.roll;
    if (!!e.rollTemporary !== p.doc.rollTemporary) set.rollTemporary = p.doc.rollTemporary;
    if (!!e.demo !== p.doc.demo) set.demo = p.doc.demo;
    if (!e.links?.github && p.doc.github) set['links.github'] = p.doc.github;
    if (p.place?.prog) Object.assign(set, { 'academic.programme': p.place.prog, 'academic.branch': p.place.branch, 'academic.cohort': p.place.cohort,
      'academic.section': p.place.section, 'academic.semesterNo': p.place.semNo });
    return set;
  };
  const unlinkedRecs = (p) => p.recs.filter(r => !p.existing || String(r.person || '') !== String(p.existing._id));

  const summary = {
    trainingRecords: students.length,
    people: plans.length,
    newPeople: plans.filter(p => !p.existing).length,
    updatedPeople: plans.filter(p => p.existing && Object.keys(changes(p)).length).length,
    recordsToLink: plans.reduce((n, p) => n + unlinkedRecs(p).length, 0),
    inSeveralBatches: plans.filter(p => p.recs.length > 1).map(p => ({ name: p.doc.name, roll: p.doc.roll, batches: p.recs.map(r => batchName.get(String(r.batch)) || '?') })),
    newProgrammes: S.newProgrammes.map(p => ({ code: p.code, name: p.name, level: p.level, durationYears: p.durationYears })),
    newBranches: S.newBranches,
    newCohorts: S.newCohorts.map(c => c.name),
    doubtful,
    possibleSame,
    withoutProgramme: plans.filter(p => !p.doc.demo && !(p.place?.prog || p.existing?.academic?.programme)).map(p => ref(p.recs[0])),
  };
  if (!apply) return { applied: false, ...summary };

  // ── apply ──
  await S.save(userId);
  const ids = (set) => Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v && typeof v === 'object' && '_id' in v ? v._id : v]));
  const fresh = plans.filter(p => !p.existing);
  const made = fresh.length ? await Person.insertMany(fresh.map(p => personDoc({ ...p.latest, ...p.doc }, p.place, userId))) : [];
  fresh.forEach((p, i) => { p.id = made[i]._id; });
  const personOps = [], studentOps = [];
  for (const p of plans) {
    if (p.existing) {
      p.id = p.existing._id;
      const set = ids(changes(p));
      if (Object.keys(set).length) personOps.push({ updateOne: { filter: { _id: p.id }, update: { $set: { ...set, updatedBy: userId } } } });
    }
    for (const r of unlinkedRecs(p)) studentOps.push({ updateOne: { filter: { _id: r._id }, update: { $set: { person: p.id } } } });
  }
  if (personOps.length) await Person.bulkWrite(personOps);
  // (linking is not an edit of the record: its 'last updated' time stays, so the next run picks the same latest record)
  if (studentOps.length) await Student.bulkWrite(studentOps, { timestamps: false });
  const sems = await recomputeSemesters();
  return { applied: true, ...summary, linked: studentOps.length, semestersUpdated: sems.updated };
}

// ── everyday: adding, editing, removing training records ─────────────

const roll1 = (r) => normRoll(r);
const isReal = (roll, temp) => !!roll && !temp && !tempRoll.isTemp(roll);
async function placesOf(personId, exceptStudentId) {
  const rows = await Student.find({ person: personId, ...(exceptStudentId ? { _id: { $ne: exceptStudentId } } : {}) })
    .select('batch').populate('batch', 'name').setOptions({ withDemo: true }).lean();
  return rows.map(r => r.batch?.name || '?');
}
async function creationMode() {
  const o = await require('../models/Organization').findById(require('./tenant').currentOrg()).select('settings.studentCreation').lean();
  return o?.settings?.studentCreation || 'trainers';
}

/**
 * Which person each new training record belongs to — BEFORE anything is saved.
 * rows: [{ name, roll, rollTemporary? }]. For each: { action: 'attach', person } | { action: 'create' } |
 * { action: 'refuse', reason } (roll belongs to someone with another name; or the college lets only the admin add new students).
 * samePerson: the admin/trainer confirmed a different spelling IS that student.
 */
async function matchRows(rows, user, { samePerson = false } = {}) {
  const real = [...new Set(rows.filter(r => isReal(r.roll, r.rollTemporary)).map(r => roll1(r.roll)))];
  const found = real.length ? await Person.find({ roll: { $in: real.map(r => new RegExp(`^\\s*${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')) } }).lean() : [];
  const byRoll = new Map(found.filter(p => !p.rollTemporary).map(p => [roll1(p.roll), p]));
  const onlyAdmin = (await creationMode()) === 'admin' && user.role !== 'superadmin';
  const out = [];
  for (const r of rows) {
    const p = isReal(r.roll, r.rollTemporary) ? byRoll.get(roll1(r.roll)) : null;
    if (p) {
      if (samePerson || sameName(r.name, p.name)) out.push({ action: 'attach', person: p });
      else {
        const where = await placesOf(p._id);
        out.push({ action: 'refuse', person: p, reason: `Roll ${r.roll} already belongs to ${p.name}${where.length ? ` (${where.join(', ')})` : ''} — check the roll, or if it is the same student use the name "${p.name}".` });
      }
    } else if (onlyAdmin) out.push({ action: 'refuse', reason: `${r.roll || r.name} is not in the college's student list — only the admin can add new students.` });
    else out.push({ action: 'create' });
  }
  return out;
}

// After the training records are saved: make the people for 'create' rows and
// link every record. records[i] ↔ matches[i] (same order as matchRows).
async function linkNew(records, matches, userId) {
  const S = await loadStructure();
  const toCreate = [];
  records.forEach((rec, i) => { if (matches[i].action === 'create') toCreate.push({ rec, place: S.placeOf(rec), i }); });
  if (toCreate.length) {
    await S.save(userId);
    const made = await Person.insertMany(toCreate.map(x => personDoc(x.rec, x.place, userId)));
    toCreate.forEach((x, k) => { matches[x.i] = { action: 'attach', person: made[k] }; });
  }
  const ops = records.map((rec, i) => matches[i].action === 'attach' && { updateOne: { filter: { _id: rec._id }, update: { $set: { person: matches[i].person._id } } } }).filter(Boolean);
  if (ops.length) await Student.bulkWrite(ops, { timestamps: false });
  records.forEach((rec, i) => { if (matches[i].action === 'attach') rec.person = matches[i].person._id; });
}

/**
 * Before saving a name / roll edit of a training record: is the new roll free?
 * Returns null (fine) or a message. A roll that another person holds is refused.
 */
async function checkIdentityEdit(record, { roll, rollTemporary }) {
  if (!isReal(roll, rollTemporary) || roll1(roll) === roll1(record.roll)) return null;
  const rx = new RegExp(`^\\s*${String(roll).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const other = await Person.findOne({ roll: rx, rollTemporary: { $ne: true }, ...(record.person ? { _id: { $ne: record.person } } : {}) }).lean();
  if (!other) return null;
  const where = await placesOf(other._id);
  return `Roll ${roll} already belongs to ${other.name}${where.length ? ` (${where.join(', ')})` : ''}. If they are the same student, merge the records instead.`;
}

// After a name / roll / GitHub edit of a training record: the person and the
// student's other batch places get the same name and roll.
async function syncIdentity(record, userId) {
  if (!record.person) {   // not linked yet: link it now (a roll held by someone else with another name stays unlinked)
    const m = await matchRows([record], { role: 'superadmin' });
    if (m[0].action !== 'refuse') await linkNew([record], m, userId);
    return;
  }
  const set = { name: record.name, roll: record.roll || '', rollTemporary: !!record.rollTemporary, updatedBy: userId };
  if (record.github) set['links.github'] = record.github;
  await Person.updateOne({ _id: record.person }, { $set: set });
  await Student.updateMany({ person: record.person, _id: { $ne: record._id } }, { $set: { name: record.name, roll: record.roll, rollTemporary: !!record.rollTemporary } }).setOptions({ withDemo: true });
}

// After a training record is removed: a person left with nothing (no other
// place, nothing filled in beyond what training copied) goes too.
async function afterRemove(personId) {
  if (!personId) return;
  if (await Student.exists({ person: personId })) return;
  const p = await Person.findById(personId).lean();
  if (!p || p.source !== 'training') return;
  const filled = Object.keys(p.custom || {}).length || p.contact?.email || p.contact?.phone || (p.ids || []).length || p.links?.linkedin || p.links?.portfolio;
  if (!filled) await Person.deleteOne({ _id: personId });
}

module.exports = { link, LinkError, PeopleError, matchRows, linkNew, checkIdentityEdit, syncIdentity, afterRemove, recomputeSemesters, semesterNow, creationMode,
  parseCourse, checkCustom, sameName, nearRoll, normName, courseCode, semesterNo, sectionCode, admissionYear, KNOWN };
