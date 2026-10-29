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

// one edit apart (an extra / missing / wrong character): 1242580900100 vs 124258090100
function nearRoll(a, b) {
  if (!a || !b || a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
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

// ── link ─────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   apply   — false: plan only (nothing saved)
 *   merge   — [[studentId, …], …] records the admin says ARE one person
 *             (resolves "doubtful" groups: same roll, different spelling)
 *   userId  — who is doing it
 */
async function link({ apply = false, merge = [], userId = null } = {}) {
  const [students, batches, semesters, programmes, cohorts, persons] = await Promise.all([
    Student.find({}).select('name roll rollTemporary course sem section batch semester person demo github updatedAt').setOptions({ withDemo: true }).lean(),
    Batch.find({}).select('name').lean(),
    Semester.find({}).select('startDate').lean(),
    Programme.find({}).lean(),
    Cohort.find({}).lean(),
    Person.find({}).lean(),
  ]);
  const batchName = new Map(batches.map(b => [String(b._id), b.name]));
  const semStart  = new Map(semesters.map(s => [String(s._id), s.startDate]));
  const personById = new Map(persons.map(p => [String(p._id), p]));
  const ref = (s) => ({ studentId: String(s._id), name: s.name, roll: s.roll, batch: batchName.get(String(s.batch)) || '?' });

  // programmes by code / alias, made on demand (plan: in memory only)
  const progByCode = new Map();
  for (const p of programmes) { progByCode.set(p.code, p); for (const a of p.aliases || []) if (!progByCode.has(a)) progByCode.set(a, p); }
  const newProgrammes = [];
  const programmeFor = (course) => {
    const code = courseCode(course);
    if (!code) return null;
    if (progByCode.has(code)) return progByCode.get(code);
    const k = KNOWN[code] || { name: String(course).trim().slice(0, 80), level: 'ug', durationYears: 4 };
    const p = { _id: null, code, name: k.name, level: k.level, durationYears: k.durationYears, termsPerYear: 2, branches: [], aliases: [], _new: true };
    progByCode.set(code, p); newProgrammes.push(p);
    return p;
  };
  // cohorts by programme + branch + year
  const cohortKey = (progCode, branch, year) => `${progCode}|${branch}|${year}`;
  const progCodeById = new Map(programmes.map(p => [String(p._id), p.code]));
  const cohortBy = new Map(cohorts.map(c => [cohortKey(progCodeById.get(String(c.programme)), c.branch || '', c.admissionYear), c]));
  const newCohorts = [];
  const cohortFor = (prog, year, section) => {
    if (!prog || !year) return null;
    const k = cohortKey(prog.code, '', year);
    let c = cohortBy.get(k);
    if (!c) { c = { _id: null, prog, branch: '', admissionYear: year, name: cohortName(prog, '', year), sections: [], _new: true }; cohortBy.set(k, c); newCohorts.push(c); }
    if (section && !c.sections.some(s => s.code === section)) { c.sections.push({ code: section, isActive: true }); c._sectionsChanged = true; }
    return c;
  };

  // ── group the records into people ──
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
    else if (s.person) key = `person:${s.person}`;                         // already linked
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
    // the person's details come from the newest record (active semester first)
    const latest = [...recs].sort((a, b) => (semStart.get(String(b.semester)) || 0) - (semStart.get(String(a.semester)) || 0)
      || new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const prog = programmeFor(latest.course);
    const semNo = semesterNo(latest.sem);
    const section = sectionCode(latest.section);
    const cohort = cohortFor(prog, admissionYear(semStart.get(String(latest.semester)), semNo, prog?.termsPerYear || 2), section);
    const existing = key.startsWith('person:') ? personById.get(key.slice(7)) : null;
    plans.push({
      existing, recs, prog, cohort,
      doc: {
        name: latest.name, roll: latest.roll || '', rollTemporary: !!(latest.rollTemporary || tempRoll.isTemp(latest.roll)),
        demo: recs.every(r => r.demo),
        github: recs.map(r => r.github).find(Boolean) || '',
        semesterNo: semNo, section,
      },
    });
  }

  // possible same person made separately: same name + same programme/semester, one roll temporary or one character apart
  const possibleSame = [];
  const loose = plans.filter(p => !p.doc.demo);
  const byName = new Map();
  for (const p of loose) { const k = `${normName(p.doc.name)}|${p.prog?.code || ''}|${p.doc.semesterNo || ''}`; (byName.get(k) || byName.set(k, []).get(k)).push(p); }
  for (const list of byName.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i].doc, b = list[j].doc;
      const why = a.rollTemporary || b.rollTemporary ? 'Same name, one has a temporary ID'
        : nearRoll(normRoll(a.roll), normRoll(b.roll)) ? 'Same name, roll numbers one character apart' : null;
      if (why) possibleSame.push({ reason: why, a: list[i].recs.map(ref), b: list[j].recs.map(ref) });
    }
  }

  const changedPerson = (p) => {
    const e = p.existing; if (!e) return true;
    return e.name !== p.doc.name || (e.roll || '') !== p.doc.roll || !!e.rollTemporary !== p.doc.rollTemporary
      || String(e.academic?.programme || '') !== String(p.prog?._id || '') || String(e.academic?.cohort || '') !== String(p.cohort?._id || '')
      || (e.academic?.section || '') !== p.doc.section || (e.academic?.semesterNo ?? null) !== p.doc.semesterNo
      || (!e.links?.github && !!p.doc.github);
  };
  const unlinkedRecs = (p) => p.recs.filter(r => !p.existing || String(r.person || '') !== String(p.existing._id));

  const summary = {
    trainingRecords: students.length,
    people: plans.length,
    newPeople: plans.filter(p => !p.existing).length,
    updatedPeople: plans.filter(p => p.existing && changedPerson(p)).length,
    recordsToLink: plans.reduce((n, p) => n + unlinkedRecs(p).length, 0),
    inSeveralBatches: plans.filter(p => p.recs.length > 1).map(p => ({ name: p.doc.name, roll: p.doc.roll, batches: p.recs.map(r => batchName.get(String(r.batch)) || '?') })),
    newProgrammes: newProgrammes.map(p => ({ code: p.code, name: p.name, level: p.level, durationYears: p.durationYears })),
    newCohorts: newCohorts.map(c => c.name),
    doubtful,
    possibleSame,
    withoutProgramme: plans.filter(p => !p.prog && !p.doc.demo).map(p => ref(p.recs[0])),
  };
  if (!apply) return { applied: false, ...summary };

  // ── apply ──
  for (const p of newProgrammes) {
    const made = await Programme.create({ code: p.code, name: p.name, level: p.level, durationYears: p.durationYears, createdBy: userId });
    p._id = made._id;
  }
  for (const c of cohortBy.values()) {
    if (c._new) {
      const made = await Cohort.create({ programme: c.prog._id, branch: '', admissionYear: c.admissionYear, name: c.name, sections: c.sections, createdBy: userId });
      c._id = made._id;
    } else if (c._sectionsChanged) {
      await Cohort.updateOne({ _id: c._id }, { $set: { sections: c.sections } });
    }
  }
  const personOps = [], studentOps = [];
  for (const p of plans) {
    const set = {
      name: p.doc.name, roll: p.doc.roll, rollTemporary: p.doc.rollTemporary,
      'academic.programme': p.prog?._id || null, 'academic.cohort': p.cohort?._id || null,
      'academic.section': p.doc.section, 'academic.semesterNo': p.doc.semesterNo,
    };
    if (p.existing) {
      if (!p.existing.links?.github && p.doc.github) set['links.github'] = p.doc.github;
      if (changedPerson(p)) personOps.push({ updateOne: { filter: { _id: p.existing._id }, update: { $set: { ...set, updatedBy: userId } } } });
      p.id = p.existing._id;
    } else {
      const made = await Person.create({
        name: p.doc.name, roll: p.doc.roll, rollTemporary: p.doc.rollTemporary, demo: p.doc.demo, source: 'training',
        academic: { programme: p.prog?._id || null, cohort: p.cohort?._id || null, section: p.doc.section, semesterNo: p.doc.semesterNo },
        links: { github: p.doc.github }, createdBy: userId,
      });
      p.id = made._id;
    }
    for (const r of unlinkedRecs(p)) studentOps.push({ updateOne: { filter: { _id: r._id }, update: { $set: { person: p.id } } } });
  }
  if (personOps.length) await Person.bulkWrite(personOps);
  // (linking is not an edit of the record: its 'last updated' time stays, so the next run picks the same latest record)
  if (studentOps.length) await Student.bulkWrite(studentOps, { timestamps: false });
  return { applied: true, ...summary, linked: studentOps.length };
}

module.exports = { link, LinkError, checkCustom, sameName, nearRoll, normName, courseCode, semesterNo, sectionCode, admissionYear, KNOWN };
