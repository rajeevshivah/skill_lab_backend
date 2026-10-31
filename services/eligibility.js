// ─────────────────────────────────────────────────────────────────────
//  Placement eligibility: who SEES a drive (audience) and who may APPLY
//  (rules over profile fields). One answer for the student's card, the
//  officer's preview counts and the apply check.
//
//  check(drive, person, ctx) → {
//    state: 'hidden'          not in the audience (programme / branch / passing year, or not studying)
//         | 'incomplete'      a value the rules need is missing → "complete your profile"
//         | 'notEligible'     a rule fails → reasons ("CGPA 6.1 — needs 6.5 or more")
//         | 'needsVerification' eligible, but the drive takes verified values only and some are not
//         | 'eligible',
//    reasons[], missing[] (labels), unverified[] (field keys the rules used that are not verified)
//  }
//  ctx = await context()  — programmes, cohorts and profile fields, loaded once.
// ─────────────────────────────────────────────────────────────────────
const Programme = require('../models/Programme');
const Cohort = require('../models/Cohort');
const ProfileField = require('../models/ProfileField');

const OPS = { gte: ['≥', (a, b) => a >= b, 'or more'], lte: ['≤', (a, b) => a <= b, 'or less'], eq: ['=', (a, b) => a === b, ''] };
// built-in values a rule may use besides the college's profile fields
const BUILT_IN = { semesterNo: { label: 'Semester', get: (p) => p.academic?.semesterNo ?? null } };

// The standard academic fields placement needs (made once per college; the
// placement officer can change labels / add more on the Fields page).
const STANDARD = [
  { key: 'tenth_percent', label: '10th %', type: 'number', min: 0, max: 100, required: true, order: 1 },
  { key: 'twelfth_percent', label: '12th / Diploma %', type: 'number', min: 0, max: 100, required: true, order: 2, help: 'Diploma students: your diploma percentage' },
  { key: 'cgpa', label: 'CGPA (till last semester)', type: 'number', min: 0, max: 10, required: true, order: 3 },
  { key: 'active_backlogs', label: 'Active backlogs', type: 'number', min: 0, max: 40, required: true, order: 4, help: 'Subjects not yet cleared. 0 if none.' },
  { key: 'tenth_marksheet', label: '10th marksheet', type: 'file', order: 5 },
  { key: 'twelfth_marksheet', label: '12th / Diploma marksheet', type: 'file', order: 6 },
  { key: 'latest_marksheet', label: 'Latest semester marksheet', type: 'file', order: 7 },
];
async function ensureStandardFields(userId = null) {
  const have = new Set((await ProfileField.find({ key: { $in: STANDARD.map(f => f.key) } }).select('key').lean()).map(f => f.key));
  const add = STANDARD.filter(f => !have.has(f.key)).map(f => ({ ...f, group: 'Academics', editableBy: 'student', needsVerification: true, createdBy: userId }));
  if (add.length) await ProfileField.insertMany(add);
  return { added: add.map(f => f.key) };
}

async function context() {
  const [programmes, cohorts, fields] = await Promise.all([
    Programme.find({}).select('name code durationYears').lean(),
    Cohort.find({}).select('programme branch admissionYear').lean(),
    ProfileField.find({}).lean(),
  ]);
  return {
    prog: new Map(programmes.map(p => [String(p._id), p])),
    cohort: new Map(cohorts.map(c => [String(c._id), c])),
    field: new Map(fields.map(f => [f.key, f])),
  };
}

// Passing year of a person: their cohort's admission year + the programme's length.
function passingYear(person, ctx) {
  const c = person.academic?.cohort && ctx.cohort.get(String(person.academic.cohort));
  const p = person.academic?.programme && ctx.prog.get(String(person.academic.programme));
  return c && p ? Math.round(c.admissionYear + (p.durationYears || 4)) : null;
}

function inAudience(drive, person, ctx) {
  if (person.demo) return true;                                   // the review account sees everything
  if ((person.status || 'studying') !== 'studying') return false;
  const a = drive.audience || {};
  if (a.programmes?.length && !a.programmes.some(x => String(x) === String(person.academic?.programme))) return false;
  if (a.branches?.length && !a.branches.includes(person.academic?.branch || '')) return false;
  if (a.passingYears?.length && !a.passingYears.includes(passingYear(person, ctx))) return false;
  return true;
}

const fmt = (v) => Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);

function check(drive, person, ctx) {
  if (!inAudience(drive, person, ctx)) return { state: 'hidden', reasons: [], missing: [], unverified: [] };
  const reasons = [], missing = [], unverified = [];
  for (const r of drive.rules || []) {
    const built = BUILT_IN[r.field], f = ctx.field.get(r.field);
    const label = built?.label || f?.label || r.field;
    const raw = built ? built.get(person) : person.custom?.[r.field];
    if (raw === undefined || raw === null || raw === '') { missing.push(label); continue; }
    const v = Number(raw);
    const [sym, test, words] = OPS[r.op];
    if (!test(v, r.value)) reasons.push(`${label} ${fmt(v)} — needs ${r.op === 'eq' ? 'to be ' : ''}${fmt(r.value)}${words ? ' ' + words : ''}`.replace('  ', ' '));
    if (!built && f?.needsVerification && !person.verified?.[r.field]) unverified.push(r.field);
  }
  const state = reasons.length ? 'notEligible' : missing.length ? 'incomplete'
    : drive.verifiedOnly && unverified.length ? 'needsVerification' : 'eligible';
  return { state, reasons, missing, unverified };
}

// Fields a rule may use (for the drive editor): number fields + built-ins.
function ruleFields(ctx) {
  return [...[...ctx.field.values()].filter(f => f.type === 'number' && f.isActive !== false).map(f => ({ key: f.key, label: f.label, min: f.min, max: f.max })),
    ...Object.entries(BUILT_IN).map(([key, b]) => ({ key, label: b.label }))];
}
// a rule must use a known field and a sensible number
function badRule(r, ctx) {
  if (!OPS[r?.op]) return 'Each rule needs a comparison (at least / at most / exactly).';
  if (!BUILT_IN[r.field] && ctx.field.get(r.field)?.type !== 'number') return `"${r.field}" is not a number field of the profile.`;
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return 'Each rule needs a number.';
  return null;
}

module.exports = { check, context, inAudience, passingYear, ensureStandardFields, ruleFields, badRule, STANDARD, OPS };
