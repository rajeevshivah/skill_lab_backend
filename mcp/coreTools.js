// ─────────────────────────────────────────────────────────────────────
//  Skill Lab MCP tools — CORE: people + academic structure
//  (shared by every module: training now; placement, prep, workshops later)
//
//  Thin wrappers over /api/people and /api/academics (ctx.api, as the
//  signed-in user) — the website's rules apply unchanged. Superadmin only.
//  Write tools: preview → the user's yes → save.
// ─────────────────────────────────────────────────────────────────────
const { z }  = require('zod');
const { writeTool, unwrap } = require('./writeTools');

const coreTools = [];
const admin = (t) => coreTools.push({ ...t, admin: true });
const objId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be an id');
const qs = (o) => { const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''); return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : ''; };
const read = (def) => ({ ...def, async handler(args, user, ctx) { return def.run(args, ctx.api); } });
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ── linking ──────────────────────────────────────────────────────────

admin(writeTool({
  name: 'link_people',
  title: 'Link training records to people (one per real student)',
  description: 'Superadmin only. Makes ONE person per real student from the training records (one per batch): same roll + matching ' +
    'name = one person (e.g. a student in two tracks). Creates programmes (from the course) and cohorts (programme + admission year) as needed. ' +
    'The preview lists: people to create/update, students in several batches, new programmes/cohorts, DOUBTFUL groups (same roll, ' +
    'different names — left unlinked: fix the roll with edit_student, or pass them in merge_groups if they ARE one person) and ' +
    '"possible same" pairs (same name, temporary or near-identical roll — made separately, check them). Safe to run again: it copies ' +
    'name/roll from the latest record and links any unlinked record; where a person is (programme, cohort, section) is set only when empty, ' +
    'and semester numbers follow the cohort + the active term. Adding/editing students keeps people in step by itself — run this only to check.',
  input: { merge_groups: z.array(z.array(objId).min(2).max(10)).max(50).optional().describe('Training record ids (student_id) that are ONE person') },
  async plan(a, user, ctx) {
    const body = { merge: a.merge_groups || [] };
    const p = unwrap(await ctx.api('POST', '/api/people/link', { ...body, apply: false }));
    const warnings = [];
    if (p.doubtful.length) warnings.push(`${p.doubtful.length} doubtful group(s) stay unlinked until resolved.`);
    if (p.possibleSame.length) warnings.push(`${p.possibleSame.length} possible same-person pair(s) to check.`);
    return {
      summary: `People: ${p.newPeople} new, ${p.updatedPeople} updated; link ${p.recordsToLink} training record(s)`,
      changes: p, warnings,
      apply: async () => unwrap(await ctx.api('POST', '/api/people/link', { ...body, apply: true })),
    };
  },
}));

// ── people ───────────────────────────────────────────────────────────

admin(read({
  name: 'list_people',
  title: 'Students as people (all modules)',
  description: 'Superadmin only. The college\'s students — one per real student — with programme, cohort, section, semester, status and ' +
    'their training batches. Filter by text (name/roll), programme_id, cohort_id, section, status. 50 per page. Also says how many training ' +
    'records are not linked to a person yet (run link_people).',
  input: {
    q: z.string().max(60).optional(), programme_id: objId.optional(), cohort_id: objId.optional(),
    section: z.string().max(10).optional(), status: z.enum(['studying', 'yearBack', 'onLeave', 'left', 'passedOut']).optional(),
    page: z.number().int().min(1).optional(),
  },
  async run(a, api) {
    return unwrap(await api('GET', '/api/people' + qs({ q: a.q, programme: a.programme_id, cohort: a.cohort_id, section: a.section, status: a.status, page: a.page })));
  },
}));

admin(read({
  name: 'get_person',
  title: 'One person (all modules)',
  description: 'Superadmin only. One student as a person: identity, other ids, programme/cohort/section/semester, status, contact, links, ' +
    'the college\'s extra profile fields (custom) and every training place (batch, semester, attendance).',
  input: { person_id: objId },
  async run(a, api) { return unwrap(await api('GET', `/api/people/${a.person_id}`)); },
}));

admin(writeTool({
  name: 'update_person',
  title: 'Update a person\'s profile',
  description: 'Superadmin only. Change where a student is (programme, branch, cohort, section, semester number, regular/lateral entry), ' +
    'status (studying, yearBack, onLeave, left, passedOut), contact, links, other ids (university, enrolment, admission, APAAR, ABC) or ' +
    'the college\'s extra profile fields (custom: {key: value}, null clears). Name and roll are changed with edit_student for now.',
  input: {
    person_id: objId,
    programme_id: objId.nullable().optional(), branch: z.string().max(20).optional(), cohort_id: objId.nullable().optional(),
    section: z.string().max(10).optional(), semester_no: z.number().int().min(1).max(16).nullable().optional(),
    entry: z.enum(['regular', 'lateral']).optional(),
    status: z.enum(['studying', 'yearBack', 'onLeave', 'left', 'passedOut']).optional(),
    email: z.string().max(120).optional(), phone: z.string().max(20).optional(),
    github: z.string().max(200).optional(), linkedin: z.string().max(200).optional(), portfolio: z.string().max(200).optional(),
    ids: z.array(z.object({ type: z.enum(['university', 'enrolment', 'admission', 'apaar', 'abc', 'other']), value: z.string().max(60) })).max(10).optional()
      .describe('Replaces the whole list'),
    custom: z.record(z.any()).optional(),
  },
  async plan(a, user, ctx) {
    const cur = unwrap(await ctx.api('GET', `/api/people/${a.person_id}`)).person;
    const body = drop({
      programme: a.programme_id, branch: a.branch, cohort: a.cohort_id, section: a.section, semesterNo: a.semester_no,
      entry: a.entry, status: a.status, ids: a.ids, custom: a.custom,
      contact: a.email !== undefined || a.phone !== undefined ? drop({ email: a.email, phone: a.phone }) : undefined,
      links: [a.github, a.linkedin, a.portfolio].some(v => v !== undefined) ? drop({ github: a.github, linkedin: a.linkedin, portfolio: a.portfolio }) : undefined,
    });
    return {
      summary: `Update ${cur.name} (${cur.roll || 'no roll'})`,
      changes: body,
      apply: async () => { const r = unwrap(await ctx.api('PATCH', `/api/people/${a.person_id}`, body)); return { person: { _id: r.person._id, name: r.person.name } }; },
    };
  },
}));

// ── academic structure ───────────────────────────────────────────────

admin(read({
  name: 'get_academic_structure',
  title: 'Programmes, branches, cohorts, sections',
  description: 'Superadmin only. The college\'s programmes (with branches and other spellings) and cohorts (programme + admission year, ' +
    'with sections and how many students each has).',
  input: {},
  async run(_a, api) { return unwrap(await api('GET', '/api/academics')); },
}));

const branchIn = z.object({ code: z.string().max(20), name: z.string().max(80), is_active: z.boolean().optional() });
admin(writeTool({
  name: 'save_programme',
  title: 'Add or change a programme',
  description: 'Superadmin only. Without programme_id: add a programme (code like BTECH is fixed once made). With programme_id: change it. ' +
    'branches REPLACES the list (a branch with students cannot be removed — set is_active false). aliases = other spellings imports use.',
  input: {
    programme_id: objId.optional(), code: z.string().max(20).optional(), name: z.string().max(80).optional(),
    level: z.enum(['certificate', 'diploma', 'ug', 'pg', 'doctoral', 'other']).optional(),
    duration_years: z.number().min(0.5).max(8).optional(), terms_per_year: z.number().int().min(1).max(4).optional(),
    department: z.string().max(80).optional(), branches: z.array(branchIn).max(40).optional(),
    aliases: z.array(z.string().max(20)).max(20).optional(), is_active: z.boolean().optional(),
  },
  async plan(a, user, ctx) {
    const body = drop({ code: a.code, name: a.name, level: a.level, durationYears: a.duration_years, termsPerYear: a.terms_per_year,
      department: a.department, aliases: a.aliases, isActive: a.is_active,
      branches: a.branches?.map(b => drop({ code: b.code, name: b.name, isActive: b.is_active })) });
    return {
      summary: a.programme_id ? `Change programme ${a.programme_id}` : `Add programme ${a.name || a.code}`,
      changes: body,
      apply: async () => unwrap(await ctx.api(a.programme_id ? 'PATCH' : 'POST', a.programme_id ? `/api/academics/programmes/${a.programme_id}` : '/api/academics/programmes', body)),
    };
  },
}));

admin(writeTool({
  name: 'save_cohort',
  title: 'Add or change a cohort',
  description: 'Superadmin only. Without cohort_id: add a cohort (programme_id + optional branch + admission_year; fixed once made). ' +
    'With cohort_id: change its name, sections (REPLACES the list; a section with students cannot be removed) or is_active.',
  input: {
    cohort_id: objId.optional(), programme_id: objId.optional(), branch: z.string().max(20).optional(),
    admission_year: z.number().int().min(1990).max(2100).optional(), name: z.string().max(80).optional(),
    sections: z.array(z.string().max(10)).max(30).optional(), is_active: z.boolean().optional(),
  },
  async plan(a, user, ctx) {
    const body = a.cohort_id ? drop({ name: a.name, sections: a.sections, isActive: a.is_active })
      : drop({ programme: a.programme_id, branch: a.branch, admissionYear: a.admission_year, name: a.name, sections: a.sections });
    return {
      summary: a.cohort_id ? `Change cohort ${a.cohort_id}` : `Add cohort (admission ${a.admission_year})`,
      changes: body,
      apply: async () => unwrap(await ctx.api(a.cohort_id ? 'PATCH' : 'POST', a.cohort_id ? `/api/academics/cohorts/${a.cohort_id}` : '/api/academics/cohorts', body)),
    };
  },
}));

// ── profile fields ───────────────────────────────────────────────────

admin(read({
  name: 'list_profile_fields',
  title: 'The college\'s extra profile fields',
  description: 'Superadmin only. Extra fields the college added to student profiles (e.g. 10th %, preferred city): key, label, type, options, ' +
    'who may fill it (staff / student) and whether a student-filled value needs staff verification.',
  input: {},
  async run(_a, api) { return unwrap(await api('GET', '/api/people/fields')); },
}));

admin(writeTool({
  name: 'save_profile_field',
  title: 'Add or change an extra profile field',
  description: 'Superadmin only. Without field_id: add one (key like tenth_percent, fixed once made; type: text, number, date, select, ' +
    'multiselect, boolean, url; select types need options). With field_id: change label, options, group, limits, who fills it, ' +
    'verification, order, or switch it off (is_active false). The type never changes.',
  input: {
    field_id: objId.optional(), key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(), label: z.string().max(80).optional(),
    type: z.enum(['text', 'number', 'date', 'select', 'multiselect', 'boolean', 'url']).optional(),
    options: z.array(z.string().max(60)).max(50).optional(), group: z.string().max(40).optional(), help: z.string().max(200).optional(),
    required: z.boolean().optional(), min: z.number().nullable().optional(), max: z.number().nullable().optional(),
    editable_by: z.enum(['staff', 'student']).optional(), needs_verification: z.boolean().optional(),
    order: z.number().int().optional(), is_active: z.boolean().optional(),
  },
  async plan(a, user, ctx) {
    const body = drop({ key: a.field_id ? undefined : a.key, label: a.label, type: a.type, options: a.options, group: a.group, help: a.help,
      required: a.required, min: a.min, max: a.max, editableBy: a.editable_by, needsVerification: a.needs_verification, order: a.order, isActive: a.is_active });
    return {
      summary: a.field_id ? `Change profile field ${a.field_id}` : `Add profile field "${a.label || a.key}"`,
      changes: body,
      apply: async () => unwrap(await ctx.api(a.field_id ? 'PATCH' : 'POST', a.field_id ? `/api/people/fields/${a.field_id}` : '/api/people/fields', body)),
    };
  },
}));

module.exports = { coreTools };
