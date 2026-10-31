// ─────────────────────────────────────────────────────────────────────
//  Skill Lab MCP tools — PLACEMENT (module "placement")
//  For the admin and the placement officer (management reads). Thin wrappers
//  over /api/placement (ctx.api, as the signed-in user): the website's rules
//  apply unchanged. Write tools: preview → the user's yes → save.
//
//  The usual flow: a JD arrives by mail → the user pastes it here → you read
//  it and call save_drive (company, role, package, dates, who sees it, rules)
//  → check the preview counts with the user → set_drive_status published →
//  drive_share gives the link + WhatsApp message.
// ─────────────────────────────────────────────────────────────────────
const { z }  = require('zod');
const { ToolError } = require('./tools');
const { writeTool, unwrap } = require('./writeTools');
const Organization = require('../models/Organization');

const placementTools = [];
const add = (t) => placementTools.push({ ...t, placement: true });
const objId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be an id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/).describe('YYYY-MM-DD or YYYY-MM-DDTHH:mm (India time)');
const qs = (o) => { const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''); return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : ''; };
const read = (def) => ({ ...def, async handler(args, user, ctx) { return def.run(args, ctx.api, user); } });
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
// a date typed in India time → the moment (end of that day when only a date is given)
const istDate = (s) => /T/.test(s) ? `${s}${s.length === 16 ? ':00' : ''}+05:30` : `${s}T23:59:00+05:30`;

async function shareFor(drive, user) {
  const org = await Organization.findById(user.org).select('hosts shortName name').lean();
  const host = (org?.hosts || []).find(h => h.includes('.')) || (process.env.FRONTEND_URL || '').replace(/^https?:\/\//, '');
  const link = `https://${host}/d/${drive.slug}`;
  const day = new Date(drive.applyBy).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  const message = `📢 ${drive.company?.name || 'New drive'} is hiring — ${drive.title}` +
    `${drive.ctc?.text ? `\n💰 ${drive.ctc.text}` : ''}${drive.location ? `\n📍 ${drive.location}` : ''}` +
    `\n🗓 Apply by ${day}\n👉 Check if you are eligible and apply: ${link}`;
  return { link, message };
}

// ── reads ────────────────────────────────────────────────────────────

add(read({
  name: 'placement_setup',
  title: 'Placement: what a drive can use',
  description: 'Fields rules can use (cgpa, tenth_percent, twelfth_percent, active_backlogs … and semesterNo), programmes with branches, ' +
    'passing years that exist, companies (ids), and whether the standard academic fields are missing (add them with add_standard_placement_fields). ' +
    'Call this before save_drive.',
  input: {},
  async run(_a, api) { return unwrap(await api('GET', '/api/placement/setup')); },
}));

add(read({
  name: 'list_drives',
  title: 'Placement drives',
  description: 'Drives (newest first) with company, role, package, last date, status (draft / published / closed), how many applied and how many opened the shared link.',
  input: { status: z.enum(['draft', 'published', 'closed']).optional() },
  async run(a, api) { return unwrap(await api('GET', '/api/placement/drives' + qs({ status: a.status }))); },
}));

add(read({
  name: 'get_drive',
  title: 'One drive in full',
  description: 'The drive (JD, package, dates, audience, rules, questions, status) and live counts: students who can see it, eligible, need to complete ' +
    'their profile, not eligible, waiting for verification, applied, withdrawn.',
  input: { drive_id: objId },
  async run(a, api) { return unwrap(await api('GET', `/api/placement/drives/${a.drive_id}`)); },
}));

add(read({
  name: 'list_applicants',
  title: 'Applicants of a drive',
  description: 'Who applied (default), withdrew, or all: name, roll, what they had when they applied (programme, branch, marks, contact), their answers, ' +
    'resume, and today\'s state — still eligible? which values are not verified yet (verify those of the shortlisted with verify_student_values).',
  input: { drive_id: objId, status: z.enum(['applied', 'withdrawn', 'all']).optional() },
  async run(a, api) { return unwrap(await api('GET', `/api/placement/drives/${a.drive_id}/applicants` + qs({ status: a.status }))); },
}));

add({
  name: 'drive_share',
  title: 'Share link + WhatsApp message for a drive',
  description: 'The link students open (it takes them straight to the drive after sign-in) and a ready message to paste on WhatsApp / the college ERP chat. Only for published drives.',
  input: { drive_id: objId },
  async handler(a, user, ctx) {
    const { drive } = unwrap(await ctx.api('GET', `/api/placement/drives/${a.drive_id}`));
    if (drive.status !== 'published') throw new ToolError('Publish the drive first (set_drive_status).');
    return shareFor(drive, user);
  },
});

// ── writes ───────────────────────────────────────────────────────────

add(writeTool({
  name: 'add_standard_placement_fields',
  title: 'Add the standard academic fields',
  description: 'Adds 10th %, 12th / Diploma %, CGPA, active backlogs and the three marksheet uploads to every student\'s profile (students fill them, ' +
    'the college verifies). Only adds what is missing.',
  input: {},
  async plan(a, user, ctx) {
    const s = unwrap(await ctx.api('GET', '/api/placement/setup'));
    if (!s.standardFieldsMissing.length) throw new ToolError('They are all there already.');
    return { summary: `Add ${s.standardFieldsMissing.length} field(s): ${s.standardFieldsMissing.join(', ')}`, changes: s.standardFieldsMissing,
      apply: async () => unwrap(await ctx.api('POST', '/api/placement/setup/standard-fields', {})) };
  },
}));

add(writeTool({
  name: 'save_company',
  title: 'Add or change a company',
  description: 'Without company_id: add a company (refused if the name exists). With company_id: change it.',
  input: { company_id: objId.optional(), name: z.string().max(120).optional(), website: z.string().max(200).optional(), industry: z.string().max(80).optional(),
    about: z.string().max(2000).optional(), contacts: z.array(z.object({ name: z.string().max(80).optional(), email: z.string().max(120).optional(), phone: z.string().max(20).optional(), role: z.string().max(60).optional() })).max(10).optional() },
  async plan(a, user, ctx) {
    const body = drop({ name: a.name, website: a.website, industry: a.industry, about: a.about, contacts: a.contacts });
    return { summary: a.company_id ? `Change company ${a.company_id}` : `Add company ${a.name}`, changes: body,
      apply: async () => unwrap(await ctx.api(a.company_id ? 'PATCH' : 'POST', a.company_id ? `/api/placement/companies/${a.company_id}` : '/api/placement/companies', body)) };
  },
}));

const ruleIn = z.object({ field: z.string().max(40).describe('a number field key from placement_setup, e.g. cgpa'), op: z.enum(['gte', 'lte', 'eq']), value: z.number() });
const questionIn = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/).optional(), label: z.string().max(160), type: z.enum(['text', 'number', 'select', 'boolean', 'url']).optional(),
  options: z.array(z.string().max(80)).max(20).optional(), required: z.boolean().optional() });

add(writeTool({
  name: 'save_drive',
  title: 'Create or change a drive (e.g. from a JD)',
  description: 'Without drive_id: a new DRAFT drive (students see nothing until set_drive_status published). With drive_id: change it. ' +
    'From a JD: fill company_id (placement_setup / save_company first), title (the role), description (the JD text, cleaned), ctc_text as written plus ' +
    'ctc_min / ctc_max in LPA, location, mode, bond, schedule (test / interview dates), apply_by. Audience = who SEES it (programme_ids, branches, ' +
    'passing_years; empty = everyone studying). Rules = who may APPLY, e.g. [{field:"cgpa",op:"gte",value:6.5},{field:"active_backlogs",op:"lte",value:0}]. ' +
    'verified_only: only college-verified values count. The preview shows how many students see it / are eligible.',
  input: {
    drive_id: objId.optional(), company_id: objId.optional(), title: z.string().max(120).optional(), description: z.string().max(20000).optional(),
    ctc_text: z.string().max(80).optional(), ctc_min: z.number().min(0).max(999).nullable().optional(), ctc_max: z.number().min(0).max(999).nullable().optional(),
    location: z.string().max(120).optional(), mode: z.enum(['onCampus', 'virtual', 'offCampus', 'pool']).optional(), bond: z.string().max(200).optional(),
    schedule: z.string().max(500).optional(), apply_by: isoDate.optional(),
    programme_ids: z.array(objId).max(20).optional(), branches: z.array(z.string().max(20)).max(30).optional(), passing_years: z.array(z.number().int()).max(10).optional(),
    rules: z.array(ruleIn).max(15).optional(), verified_only: z.boolean().optional(), resume_required: z.boolean().optional(),
    questions: z.array(questionIn).max(10).optional(), public_preview: z.boolean().optional(),
  },
  async plan(a, user, ctx) {
    const body = drop({
      company: a.company_id, title: a.title, description: a.description, location: a.location, mode: a.mode, bond: a.bond, schedule: a.schedule,
      applyBy: a.apply_by ? istDate(a.apply_by) : undefined, rules: a.rules, verifiedOnly: a.verified_only, resumeRequired: a.resume_required,
      questions: a.questions, publicPreview: a.public_preview,
      ctc: [a.ctc_text, a.ctc_min, a.ctc_max].some(v => v !== undefined) ? { text: a.ctc_text || '', min: a.ctc_min ?? null, max: a.ctc_max ?? null } : undefined,
      audience: [a.programme_ids, a.branches, a.passing_years].some(v => v !== undefined) ? { programmes: a.programme_ids || [], branches: a.branches || [], passingYears: a.passing_years || [] } : undefined,
    });
    let cur = null;
    if (a.drive_id) cur = unwrap(await ctx.api('GET', `/api/placement/drives/${a.drive_id}`)).drive;
    else if (!a.company_id || !a.title || !a.apply_by) throw new ToolError('A new drive needs company_id, title and apply_by.');
    const check = unwrap(await ctx.api('POST', '/api/placement/drives/check', {
      audience: body.audience || cur?.audience || {}, rules: body.rules || cur?.rules || [], verifiedOnly: body.verifiedOnly ?? cur?.verifiedOnly ?? false }));
    return {
      summary: a.drive_id ? `Change drive "${cur.title}"` : `New DRAFT drive "${a.title}"`,
      changes: { ...body, ...(body.description ? { description: body.description.slice(0, 300) + (body.description.length > 300 ? '…' : '') } : {}),
        studentsWhoWouldSeeIt: check.counts },
      apply: async () => unwrap(await ctx.api(a.drive_id ? 'PATCH' : 'POST', a.drive_id ? `/api/placement/drives/${a.drive_id}` : '/api/placement/drives', body)),
    };
  },
}));

add(writeTool({
  name: 'set_drive_status',
  title: 'Publish, close or un-publish a drive',
  description: 'published: students who can see it get it on their dashboard and the share link works (then use drive_share). closed: no more applications. ' +
    'draft: hide it again (only before anyone applied).',
  input: { drive_id: objId, status: z.enum(['published', 'closed', 'draft']) },
  async plan(a, user, ctx) {
    const { drive, counts } = unwrap(await ctx.api('GET', `/api/placement/drives/${a.drive_id}`));
    return { summary: `${a.status === 'published' ? 'Publish' : a.status === 'closed' ? 'Close' : 'Un-publish'} "${drive.title}" (${drive.company?.name})`,
      changes: { from: drive.status, to: a.status, ...(a.status === 'published' ? { studentsWhoWillSeeIt: counts.visible, eligibleNow: counts.eligible } : { applied: counts.applied }) },
      apply: async () => {
        const r = unwrap(await ctx.api('POST', `/api/placement/drives/${a.drive_id}/status`, { status: a.status }));
        return a.status === 'published' ? { ...r, share: await shareFor({ ...drive, ...r.drive, company: drive.company }, user) } : r;
      } };
  },
}));

add(writeTool({
  name: 'verify_student_values',
  title: 'Verify (or un-verify) a student\'s marks',
  description: 'Mark profile values as checked by the college (e.g. cgpa, tenth_percent after seeing the marksheet). person_id from list_applicants or list_people. ' +
    'verified=false takes the mark back. A student changing a verified value makes it unverified again.',
  input: { person_id: objId, keys: z.array(z.string().max(40)).min(1).max(20), verified: z.boolean().optional() },
  async plan(a, user, ctx) {
    const p = unwrap(await ctx.api('GET', `/api/people/${a.person_id}`)).person;
    return { summary: `${a.verified === false ? 'Un-verify' : 'Verify'} ${a.keys.join(', ')} of ${p.name} (${p.roll})`,
      changes: Object.fromEntries(a.keys.map(k => [k, p.custom?.[k] ?? '(empty)'])),
      apply: async () => unwrap(await ctx.api('POST', '/api/placement/verify', { personId: a.person_id, keys: a.keys, verified: a.verified !== false })) };
  },
}));

add(writeTool({
  name: 'import_marks',
  title: 'Import marks from the college\'s records (saved as verified)',
  description: 'rows: [{ roll, cgpa, tenth_percent, twelfth_percent, active_backlogs, … }] — column names are profile field keys. Values are saved as ' +
    'VERIFIED (they come from the college). The preview shows matched rolls, rolls not found and bad values.',
  input: { rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).min(1).max(3000) },
  async plan(a, user, ctx) {
    const p = unwrap(await ctx.api('POST', '/api/placement/import', { rows: a.rows, apply: false }));
    return { summary: `Import marks for ${p.matched} student(s) (${p.changes} values, verified)`, changes: p,
      warnings: [...(p.notFound.length ? [`${p.notFound.length} roll(s) not found`] : []), ...(p.problems.length ? [`${p.problems.length} row(s) with problems`] : [])],
      apply: async () => unwrap(await ctx.api('POST', '/api/placement/import', { rows: a.rows, apply: true })) };
  },
}));

module.exports = { placementTools };
