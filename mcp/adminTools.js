// ─────────────────────────────────────────────────────────────────────
//  Skill Lab MCP tools — ROUND 3: ADMIN
//
//  • Tools marked `admin: true` are shown ONLY to superadmin users.
//    Trainers' AI apps never even see them.
//  • Student and syllabus tools are for everyone, scoped exactly like the
//    website (a trainer can only touch their own batches).
//  • Every change goes through preview → your yes → save (writeTool).
//  • Saving calls the EXISTING website route inside the server, as you
//    (ctx.api). So all website rules apply unchanged: last-superadmin
//    protection, duplicate-roll checks, cycle date-overlap checks, etc.
//  • NO hard deletes. "Remove" means reversible: deactivate a user,
//    take a trainer off a batch, mark a batch inactive, archive a semester.
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { z }  = require('zod');

const User     = require('../models/User');
const Semester = require('../models/Semester');
const Batch    = require('../models/Batch');
const Student  = require('../models/Student');
const Cycle    = require('../models/Cycle');
const Plan     = require('../models/Plan');
const { canAccessBatch } = require('../middleware/auth');
const { ToolError, helpers } = require('./tools');
const { requireId, dayKey, ymd } = helpers;
const { writeTool, unwrap, resolveStudents, studentRef } = require('./writeTools');

const adminTools = [];
const admin = (t) => adminTools.push({ ...t, admin: true });
const anyone = (t) => adminTools.push(t);

// ── lookups ──────────────────────────────────────────────────────────

const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

// Find ONE user by id, exact email, or (unique) part of the name.
async function findUser(ref) {
  const r = String(ref || '').trim();
  if (!r) throw new ToolError('Say which user (email or name).');
  if (/^[a-f0-9]{24}$/i.test(r)) { const u = await User.findById(r).select('-password'); if (u) return u; }
  if (r.includes('@')) {
    const u = await User.findOne({ email: r.toLowerCase() }).select('-password');
    if (!u) throw new ToolError(`No user with email ${r}.`);
    return u;
  }
  const m = await User.find({ name: rx(r) }).select('-password');
  if (m.length === 1) return m[0];
  throw new ToolError(m.length
    ? `"${r}" matches several users: ${m.map(u => `${u.name} <${u.email}>`).join(', ')}. Use the email.`
    : `No user named "${r}". Use list_users to see everyone.`);
}

async function findBatch(id) {
  requireId(id, 'batch');
  const b = await Batch.findById(id).populate('trainers', 'name email').populate('semester', 'name status');
  if (!b) throw new ToolError('Batch not found.');
  return b;
}

async function findSemester(ref) {
  if (ref && /^[a-f0-9]{24}$/i.test(ref)) { const s = await Semester.findById(ref); if (s) return s; }
  if (ref) {
    const m = await Semester.find({ name: rx(ref) });
    if (m.length === 1) return m[0];
    throw new ToolError(m.length ? `"${ref}" matches several semesters: ${m.map(s => s.name).join(', ')}` : `No semester "${ref}".`);
  }
  const active = await Semester.findOne({ status: 'active' }).sort('-createdAt');
  if (!active) throw new ToolError('There is no active semester. Create one first.');
  return active;
}

// Strong temporary password: readable, no look-alike characters.
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  let p = '';
  for (let i = 0; i < 12; i++) p += chars[b[i] % chars.length];
  return `${p.slice(0, 4)}-${p.slice(4, 8)}-${p.slice(8)}`;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD');
const PW_NOTE = 'Share this password with them privately (not in a group). They can be given a new one any time with update_user reset_password.';

// ═════════════════════ PEOPLE (admin) ═════════════════════════════════

admin({
  name: 'list_users',
  title: 'List users / trainers',
  description: 'Superadmin only. All Skill Lab users with role, active status, and the batches each one is assigned to in the active semester.',
  input: { include_inactive: z.boolean().optional().describe('Default true') },
  async handler({ include_inactive = true }) {
    const users = await User.find(include_inactive ? {} : { isActive: true }).select('-password').sort('name');
    const active = await Semester.findOne({ status: 'active' });
    const batches = await Batch.find(active ? { semester: active._id } : {}).select('name trainers');
    return {
      users: users.map(u => ({
        id: u._id, name: u.name, email: u.email, role: u.role, active: u.isActive,
        batches: batches.filter(b => b.trainers.some(t => t.toString() === u._id.toString())).map(b => b.name),
      })),
    };
  },
});

admin(writeTool({
  name: 'create_user',
  title: 'Create a trainer / user account',
  description:
    'Superadmin only. Create a login for a new trainer (role trainer), co-trainer (cannot delete anything on the website) or superadmin. ' +
    'A strong temporary password is generated by the server and shown ONCE after saving. ' +
    'To give them batches, use update_batch with add_trainers afterwards.',
  input: {
    name: z.string().min(2).max(80),
    email: z.string().email(),
    role: z.enum(['trainer', 'cotrainer', 'superadmin']).optional().describe('Default trainer'),
  },
  async plan(args, user, ctx) {
    const email = args.email.trim().toLowerCase();
    const role = args.role || 'trainer';
    const exists = await User.findOne({ email });
    if (exists) throw new ToolError(`${email} already has an account (${exists.name}, ${exists.isActive ? 'active' : 'inactive'}). Use update_user instead.`);
    const warnings = role === 'superadmin' ? ['A superadmin can see and change EVERYTHING, including other users.'] : [];
    return {
      summary: `Create ${role} account for ${args.name.trim()} <${email}>`,
      changes: { name: args.name.trim(), email, role, password: 'a temporary password will be generated and shown after saving' },
      warnings,
      apply: async () => {
        const password = tempPassword();
        const out = unwrap(await ctx.api('POST', '/api/auth/create-user', { name: args.name.trim(), email, password, role }));
        return { user: out.user, temporaryPassword: password, note: PW_NOTE, loginUrl: 'https://skilllab.sheat.ac.in/login' };
      },
    };
  },
}));

admin(writeTool({
  name: 'update_user',
  title: 'Update a user (rename, role, activate/deactivate, reset password)',
  description:
    'Superadmin only. Change a user\'s name or role, deactivate them (they can no longer log in and all their AI tokens stop working — ' +
    'this is how you "remove" a trainer; it is reversible) or reactivate them, or reset their password to a new generated one. ' +
    'The last active superadmin cannot be demoted or deactivated.',
  input: {
    user: z.string().describe('Email (best), name, or id'),
    name: z.string().min(2).max(80).optional(),
    role: z.enum(['trainer', 'cotrainer', 'superadmin']).optional(),
    active: z.boolean().optional().describe('false = deactivate (reversible)'),
    reset_password: z.boolean().optional(),
  },
  async plan(args, me, ctx) {
    const u = await findUser(args.user);
    const body = {}, changes = [];
    if (args.name !== undefined && args.name !== u.name) { body.name = args.name; changes.push({ field: 'name', from: u.name, to: args.name }); }
    if (args.role !== undefined && args.role !== u.role) { body.role = args.role; changes.push({ field: 'role', from: u.role, to: args.role }); }
    if (args.active !== undefined && args.active !== u.isActive) { body.isActive = args.active; changes.push({ field: 'active', from: u.isActive, to: args.active }); }
    if (args.reset_password) changes.push({ field: 'password', to: 'new temporary password (shown after saving)' });
    if (!changes.length) throw new ToolError(`Nothing to change for ${u.name}.`);

    const warnings = [];
    if (body.isActive === false) {
      const n = await Batch.countDocuments({ trainers: u._id });
      warnings.push(`${u.name} will not be able to log in, and their AI tokens stop working.` +
        (n ? ` They are still listed as trainer on ${n} batch(es) — remove them with update_batch if needed.` : ''));
    }
    if (String(u._id) === String(me._id) && (body.isActive === false || (body.role && body.role !== 'superadmin')))
      warnings.push('This is YOUR OWN account — you may lose admin access.');
    return {
      summary: `Update ${u.name} <${u.email}>`,
      changes, warnings,
      apply: async () => {
        const password = args.reset_password ? tempPassword() : undefined;
        const out = unwrap(await ctx.api('PATCH', `/api/auth/users/${u._id}`, { ...body, ...(password ? { password } : {}) }));
        return { user: { name: out.user.name, email: out.user.email, role: out.user.role, active: out.user.isActive },
                 ...(password ? { temporaryPassword: password, note: PW_NOTE } : {}) };
      },
    };
  },
}));

// ═════════════════════ SEMESTERS (admin) ══════════════════════════════

admin(writeTool({
  name: 'create_semester',
  title: 'Start a new semester',
  description:
    'Superadmin only. "Start New Semester": creates a fresh active semester. IMPORTANT: the currently active semester is ' +
    'automatically archived (same as the website). Batches, students and cycles stay with their own semester.',
  input: { name: z.string().min(2).max(80).describe('e.g. "Even sem 2026-2027"'), start_date: isoDate.optional(), notes: z.string().max(500).optional() },
  async plan(args, me, ctx) {
    const current = await Semester.findOne({ status: 'active' });
    const batches = current ? await Batch.countDocuments({ semester: current._id }) : 0;
    return {
      summary: `Start new semester "${args.name}"`,
      changes: { create: { name: args.name, startDate: args.start_date || 'today', status: 'active' },
                 archive: current ? { name: current.name, batches } : null },
      warnings: current ? [`"${current.name}" (${batches} batches) will be ARCHIVED. The dashboard and AI default view will switch to the new semester, which starts with no batches.`] : [],
      apply: async () => ({ semester: unwrap(await ctx.api('POST', '/api/semesters', { name: args.name, startDate: args.start_date, notes: args.notes })).semester }),
    };
  },
}));

admin(writeTool({
  name: 'update_semester',
  title: 'Rename / archive / reactivate a semester',
  description: 'Superadmin only. Rename a semester, change notes, archive it, or make it active again (making one active archives the others).',
  input: {
    semester: z.string().describe('Semester id or name'),
    name: z.string().min(2).max(80).optional(), notes: z.string().max(500).optional(),
    status: z.enum(['active', 'archived']).optional(),
  },
  async plan(args, me, ctx) {
    const s = await findSemester(args.semester);
    const body = {}, changes = [];
    for (const k of ['name', 'notes', 'status'])
      if (args[k] !== undefined && args[k] !== s[k]) { body[k] = args[k]; changes.push({ field: k, from: s[k], to: args[k] }); }
    if (!changes.length) throw new ToolError('Nothing to change.');
    const warnings = [];
    if (body.status === 'active') {
      const cur = await Semester.findOne({ status: 'active', _id: { $ne: s._id } });
      if (cur) warnings.push(`"${cur.name}" will be archived.`);
    }
    if (body.status === 'archived') warnings.push('Archived semesters drop out of the dashboard and the AI\'s default view.');
    if (body.status === 'archived' && args.status) body.endDate = new Date();
    return {
      summary: `Update semester "${s.name}"`, changes, warnings,
      apply: async () => ({ semester: unwrap(await ctx.api('PATCH', `/api/semesters/${s._id}`, body)).semester }),
    };
  },
}));

// ═════════════════════ BATCHES (admin) ════════════════════════════════

admin(writeTool({
  name: 'create_batch',
  title: 'Create a batch',
  description:
    'Superadmin only. Create a training batch in the active semester (or a named one): name, track (e.g. MERN, Spring Boot, ' +
    'Data Analysis, Dev Core), composition (who is in it, e.g. "BTech 5th, 7th & BCA 5th"), trainers by name/email, and ' +
    'optionally copy the syllabus topics from another batch. Students are added afterwards with add_students.',
  input: {
    name: z.string().min(2).max(80), track: z.string().max(60).optional(), composition: z.string().max(200).optional(),
    trainers: z.array(z.string()).max(10).optional().describe('Trainer emails or names'),
    copy_plan_from_batch_id: z.string().optional(),
    semester: z.string().optional().describe('Semester id or name; default = active'),
  },
  async plan(args, me, ctx) {
    const sem = await findSemester(args.semester);
    const clash = await Batch.findOne({ semester: sem._id, name: args.name.trim() });
    if (clash) throw new ToolError(`A batch named "${args.name}" already exists in ${sem.name}.`);
    const trainers = [];
    for (const t of args.trainers || []) trainers.push(await findUser(t));
    const inactive = trainers.filter(t => !t.isActive);
    let copyFrom = null;
    if (args.copy_plan_from_batch_id) {
      copyFrom = await findBatch(args.copy_plan_from_batch_id);
      const p = await Plan.findOne({ batch: copyFrom._id });
      copyFrom.topicCount = p ? p.topics.length : 0;
    }
    return {
      summary: `Create batch "${args.name.trim()}" in ${sem.name}`,
      changes: { name: args.name.trim(), track: args.track || '', composition: args.composition || '',
                 trainers: trainers.map(t => t.name), syllabus: copyFrom ? `copy ${copyFrom.topicCount} topics from ${copyFrom.name}` : 'empty' },
      warnings: inactive.map(t => `${t.name} is deactivated.`),
      apply: async () => {
        const out = unwrap(await ctx.api('POST', '/api/batches', {
          name: args.name.trim(), semester: sem._id, track: args.track, composition: args.composition,
          trainers: trainers.map(t => t._id), copyPlanFrom: copyFrom?._id,
        }));
        return { batch: { id: out.batch._id, name: out.batch.name } };
      },
    };
  },
}));

admin(writeTool({
  name: 'update_batch',
  title: 'Edit a batch / add or remove trainers',
  description:
    'Superadmin only. Rename a batch, change its track or composition, ADD or REMOVE trainers (by name or email), or mark it ' +
    'inactive/active. This is how you "remove" a trainer from a batch or retire a batch — nothing is deleted.',
  input: {
    batch_id: z.string(),
    name: z.string().min(2).max(80).optional(), track: z.string().max(60).optional(), composition: z.string().max(200).optional(),
    add_trainers: z.array(z.string()).max(10).optional(), remove_trainers: z.array(z.string()).max(10).optional(),
    active: z.boolean().optional(),
  },
  async plan(args, me, ctx) {
    const b = await findBatch(args.batch_id);
    const body = {}, changes = [], warnings = [];
    for (const k of ['name', 'track', 'composition'])
      if (args[k] !== undefined && args[k] !== b[k]) { body[k] = args[k]; changes.push({ field: k, from: b[k] || null, to: args[k] }); }
    if (args.active !== undefined && args.active !== b.isActive) { body.isActive = args.active; changes.push({ field: 'active', from: b.isActive, to: args.active }); }

    if (args.add_trainers || args.remove_trainers) {
      const ids = new Map(b.trainers.map(t => [t._id.toString(), t.name]));
      for (const r of args.add_trainers || []) {
        const u = await findUser(r);
        if (!u.isActive) warnings.push(`${u.name} is deactivated.`);
        if (ids.has(u._id.toString())) warnings.push(`${u.name} is already a trainer here.`);
        ids.set(u._id.toString(), u.name);
      }
      for (const r of args.remove_trainers || []) {
        const u = await findUser(r);
        if (!ids.has(u._id.toString())) warnings.push(`${u.name} is not a trainer of this batch.`);
        ids.delete(u._id.toString());
      }
      const before = b.trainers.map(t => t.name), after = [...ids.values()];
      if (before.join('|') !== after.join('|')) { body.trainers = [...ids.keys()]; changes.push({ field: 'trainers', from: before, to: after }); }
      if (!ids.size) warnings.push('The batch will have NO trainers — only superadmin can then work on it.');
    }
    if (!changes.length) throw new ToolError('Nothing to change.');
    return {
      summary: `Update batch "${b.name}"`, changes, warnings,
      apply: async () => {
        const out = unwrap(await ctx.api('PATCH', `/api/batches/${b._id}`, body));
        return { batch: { id: out.batch._id, name: out.batch.name, trainers: (out.batch.trainers || []).map(t => t.name) } };
      },
    };
  },
}));

admin(writeTool({
  name: 'set_roster_lock',
  title: 'Lock / unlock a batch roster',
  description: 'Superadmin only. Locking marks the roster as final: cycle attendance averages become "final" instead of "provisional". It does NOT block adding students or entering marks (soft lock, same as website).',
  input: { batch_id: z.string(), locked: z.boolean() },
  async plan(args, me, ctx) {
    const b = await findBatch(args.batch_id);
    if (!!b.rosterLocked === args.locked) throw new ToolError(`The roster is already ${args.locked ? 'locked' : 'unlocked'}.`);
    return {
      summary: `${args.locked ? 'Lock' : 'Unlock'} roster of "${b.name}"`,
      changes: { rosterLocked: { from: !!b.rosterLocked, to: args.locked } },
      apply: async () => ({ rosterLocked: unwrap(await ctx.api('PATCH', `/api/batches/${b._id}/roster-lock`, { locked: args.locked })).batch.rosterLocked }),
    };
  },
}));

// ═════════════════════ CYCLES (admin) ═════════════════════════════════

admin(writeTool({
  name: 'create_cycles',
  title: 'Create cycle(s)',
  description:
    'Superadmin only. Create a cycle for one batch, or the same dates for several batches at once (each batch gets its own next ' +
    'number). Batches whose existing cycle overlaps the dates are skipped. A cycle starts as "active" (teaching).',
  input: {
    batch_ids: z.array(z.string()).min(1).max(30),
    start_date: isoDate, end_date: isoDate,
    name: z.string().max(80).optional(),
    number: z.number().int().min(1).max(100).optional().describe('Only when creating for ONE batch; default = next number'),
  },
  async plan(args, me, ctx) {
    if (args.end_date < args.start_date) throw new ToolError('End date is before start date.');
    if (args.number && args.batch_ids.length > 1) throw new ToolError('number can only be set when creating for one batch.');
    const s = dayKey(args.start_date), e = dayKey(args.end_date);
    const rows = [];
    for (const id of args.batch_ids) {
      const b = await findBatch(id);
      const overlap = await Cycle.findOne({ batch: b._id, startDate: { $lte: e }, endDate: { $gte: s } });
      const last = await Cycle.findOne({ batch: b._id }).sort('-number');
      const num = args.number || (last ? last.number + 1 : 1);
      const taken = args.number ? await Cycle.findOne({ batch: b._id, number: args.number }) : null;
      rows.push({ batch: b.name, number: num,
                  willCreate: !overlap && !taken,
                  ...(overlap ? { skippedBecause: `overlaps Cycle ${overlap.number} (${ymd(overlap.startDate)} to ${ymd(overlap.endDate)})` } : {}),
                  ...(taken ? { skippedBecause: `Cycle ${args.number} already exists` } : {}) });
    }
    if (!rows.some(r => r.willCreate)) throw new ToolError('Nothing would be created: ' + rows.map(r => `${r.batch}: ${r.skippedBecause}`).join('; '));
    return {
      summary: `Create ${rows.filter(r => r.willCreate).length} cycle(s), ${args.start_date} to ${args.end_date}`,
      changes: rows,
      apply: async () => {
        if (args.batch_ids.length === 1) {
          const out = unwrap(await ctx.api('POST', '/api/cycles', { batch: args.batch_ids[0], number: args.number, name: args.name, startDate: args.start_date, endDate: args.end_date }));
          return { created: [{ number: out.cycle.number, cycleId: out.cycle._id }] };
        }
        const out = unwrap(await ctx.api('POST', '/api/cycles/bulk', { batches: args.batch_ids, name: args.name, startDate: args.start_date, endDate: args.end_date }));
        return { created: out.created, skipped: out.skipped };
      },
    };
  },
}));

admin(writeTool({
  name: 'update_cycle',
  title: 'Edit a cycle',
  description: 'Superadmin only. Change a cycle\'s dates, number or name. Not allowed while the cycle is closed (reopen it first with set_cycle_status).',
  input: { cycle_id: z.string(), start_date: isoDate.optional(), end_date: isoDate.optional(), name: z.string().max(80).optional(), number: z.number().int().min(1).max(100).optional() },
  async plan(args, me, ctx) {
    requireId(args.cycle_id, 'cycle');
    const c = await Cycle.findById(args.cycle_id).populate('batch', 'name');
    if (!c) throw new ToolError('Cycle not found.');
    if (c.status === 'closed') throw new ToolError('This cycle is closed. Reopen it first (set_cycle_status open_report).');
    const body = {}, changes = [];
    const cur = { start_date: ymd(c.startDate), end_date: ymd(c.endDate), name: c.name, number: c.number };
    const map = { start_date: 'startDate', end_date: 'endDate', name: 'name', number: 'number' };
    for (const k of Object.keys(map))
      if (args[k] !== undefined && args[k] !== cur[k]) { body[map[k]] = args[k]; changes.push({ field: k, from: cur[k], to: args[k] }); }
    if (!changes.length) throw new ToolError('Nothing to change.');
    const ns = args.start_date || cur.start_date, ne = args.end_date || cur.end_date;
    if (ne < ns) throw new ToolError('End date would be before start date.');
    const overlap = await Cycle.findOne({ batch: c.batch._id, _id: { $ne: c._id }, startDate: { $lte: dayKey(ne) }, endDate: { $gte: dayKey(ns) } });
    return {
      summary: `Edit Cycle ${c.number} — ${c.batch.name}`, changes,
      warnings: overlap ? [`New dates overlap Cycle ${overlap.number} (${ymd(overlap.startDate)} to ${ymd(overlap.endDate)}).`] : [],
      apply: async () => { const out = unwrap(await ctx.api('PATCH', `/api/cycles/${c._id}`, body)); return { cycle: { number: out.cycle.number, start: ymd(out.cycle.startDate), end: ymd(out.cycle.endDate) } }; },
    };
  },
}));

admin(writeTool({
  name: 'set_cycle_status',
  title: 'Open the report / close a cycle',
  description:
    'Superadmin only. open_report = let trainers fill the cycle report (also reopens a closed cycle). close = freeze the cycle: ' +
    'any report numbers the trainer left empty are filled from live data (attendance, sessions, topics, top 3) and locked.',
  input: { cycle_id: z.string(), action: z.enum(['open_report', 'close']) },
  async plan(args, me, ctx) {
    requireId(args.cycle_id, 'cycle');
    const c = await Cycle.findById(args.cycle_id).populate('batch', 'name');
    if (!c) throw new ToolError('Cycle not found.');
    const to = args.action === 'close' ? 'closed' : 'report-open';
    if (c.status === to) throw new ToolError(`Cycle ${c.number} is already ${to}.`);
    const warnings = [];
    if (to === 'closed') {
      if (!c.report?.submitted) warnings.push('The trainer has NOT submitted the report yet.');
      warnings.push('After closing, the report and its numbers are frozen. Trainers cannot edit until you reopen.');
    }
    return {
      summary: `${args.action === 'close' ? 'Close' : 'Open report for'} Cycle ${c.number} — ${c.batch.name}`,
      changes: { status: { from: c.status, to } }, warnings,
      apply: async () => ({ status: unwrap(await ctx.api('POST', `/api/cycles/${c._id}/${args.action === 'close' ? 'close' : 'open'}`, {})).cycle.status }),
    };
  },
}));

// ═════════════════════ STUDENTS ═══════════════════════════════════════

anyone(writeTool({
  name: 'add_students',
  title: 'Add students to a batch',
  description:
    'Add one or many students to a batch (roll, name, course, sem, section). Same checks as the website import: rows with no ' +
    'name or a bad roll are skipped, rolls already in this batch are skipped, rolls that exist in ANOTHER batch are added and ' +
    'flagged (resolve on the Duplicates page). Trainers can add only to their own batches. Max 1000 per call.',
  input: {
    batch_id: z.string(),
    students: z.array(z.object({
      roll: z.string().max(40).optional(), name: z.string().max(120),
      course: z.string().max(40).optional(), sem: z.string().max(20).optional(), section: z.string().max(20).optional(), year: z.string().max(20).optional(),
    })).min(1).max(1000),
  },
  async plan(args, me, ctx) {
    const b = await findBatch(args.batch_id);
    if (!(await canAccessBatch(me, b._id))) throw new ToolError('You can only add students to your own batches.');
    const pv = unwrap(await ctx.api('POST', '/api/students/bulk?preview=1', { batch: b._id, rows: args.students }));
    if (!pv.willImport) throw new ToolError('Nothing would be added: ' + pv.skipped.slice(0, 20).map(s => `line ${s.line} ${s.roll || ''} ${s.name || ''}: ${s.reason}`).join('; '));
    return {
      summary: `Add ${pv.willImport} student(s) to "${b.name}"`,
      changes: { willAdd: pv.willImport, sample: pv.sample,
                 skipped: pv.skipped.slice(0, 50), alsoInAnotherBatch: pv.duplicates.slice(0, 50) },
      warnings: [
        ...(pv.skippedCount ? [`${pv.skippedCount} row(s) will be skipped.`] : []),
        ...(pv.duplicateCount ? [`${pv.duplicateCount} roll(s) are already in another batch — they'll be added and flagged on the Duplicates page.`] : []),
      ],
      apply: async () => {
        const out = unwrap(await ctx.api('POST', '/api/students/bulk', { batch: b._id, rows: args.students }));
        return { added: out.imported, skipped: out.skippedCount, flaggedDuplicates: out.duplicateCount };
      },
    };
  },
}));

anyone(writeTool({
  name: 'edit_student',
  title: 'Edit a student',
  description: 'Fix a student\'s name, roll, course, sem, section or year, or set the "flagged / watch this one" mark. Trainers only for their own batches. Student is found by student_id, or roll + batch_id.',
  input: {
    student_id: z.string().optional(), roll: z.string().optional(), batch_id: z.string().optional().describe('Needed with roll'),
    name: z.string().max(120).optional(), new_roll: z.string().max(40).optional(),
    course: z.string().max(40).optional(), sem: z.string().max(20).optional(), section: z.string().max(20).optional(), year: z.string().max(20).optional(),
    flagged: z.boolean().optional(),
  },
  async plan(args, me, ctx) {
    let s;
    if (args.student_id) { requireId(args.student_id, 'student'); s = await Student.findById(args.student_id).select('-photo'); }
    else if (args.roll && args.batch_id) {
      requireId(args.batch_id, 'batch');
      const r = await resolveStudents(args.batch_id, [{ roll: args.roll }]);
      if (r.problems.length) throw new ToolError(r.problems.join('; '));
      s = await Student.findById(r.found[0]._id).select('-photo');
    } else throw new ToolError('Give student_id, or roll + batch_id.');
    if (!s) throw new ToolError('Student not found.');
    if (!(await canAccessBatch(me, s.batch))) throw new ToolError('You can only edit students in your own batches.');
    const body = {}, changes = [];
    const map = { name: 'name', new_roll: 'roll', course: 'course', sem: 'sem', section: 'section', year: 'year', flagged: 'flagged' };
    for (const [a, f] of Object.entries(map))
      if (args[a] !== undefined && args[a] !== s[f]) { body[f] = args[a]; changes.push({ field: f, from: s[f], to: args[a] }); }
    if (!changes.length) throw new ToolError('Nothing to change.');
    return {
      summary: `Edit student ${s.name} (${s.roll})`, changes,
      apply: async () => { const out = unwrap(await ctx.api('PUT', `/api/students/${s._id}`, body)); return { student: { name: out.student.name, roll: out.student.roll } }; },
    };
  },
}));

admin(writeTool({
  name: 'move_student',
  title: 'Move a student to another batch',
  description: 'Superadmin only. Move a student to a different batch (e.g. after track lock). Their existing marks stay attached to the old batch\'s cycles.',
  input: { student_id: z.string(), to_batch_id: z.string() },
  async plan(args, me, ctx) {
    requireId(args.student_id, 'student');
    const s = await Student.findById(args.student_id).select('name roll batch').populate('batch', 'name');
    if (!s) throw new ToolError('Student not found.');
    const to = await findBatch(args.to_batch_id);
    if (String(s.batch?._id) === String(to._id)) throw new ToolError(`${s.name} is already in ${to.name}.`);
    const clash = s.roll ? await Student.findOne({ batch: to._id, roll: s.roll }) : null;
    return {
      summary: `Move ${s.name} (${s.roll}) → ${to.name}`,
      changes: { from: s.batch?.name, to: to.name },
      warnings: clash ? [`${to.name} already has roll ${s.roll} (${clash.name}) — this will create a duplicate.`] : [],
      apply: async () => { unwrap(await ctx.api('POST', `/api/students/${s._id}/move`, { batch: to._id })); return { movedTo: to.name }; },
    };
  },
}));

// ═════════════════════ SYLLABUS PLAN ══════════════════════════════════

anyone(writeTool({
  name: 'set_batch_plan',
  title: 'Edit a batch syllabus plan',
  description:
    'Edit a batch\'s syllabus topic list (used by daily logs and the Today dashboard). mode "append" adds topics at the end ' +
    '(existing ones and their done/pending status are kept); mode "replace" sets the whole list — topics not in the new list are ' +
    'removed, and kept titles keep their status. Trainers can edit only their own batches.',
  input: { batch_id: z.string(), mode: z.enum(['append', 'replace']), topics: z.array(z.string().min(1).max(200)).min(1).max(200) },
  async plan(args, me, ctx) {
    const b = await findBatch(args.batch_id);
    if (!(await canAccessBatch(me, b._id))) throw new ToolError('You can only edit the plan of your own batches.');
    const plan = await Plan.findOne({ batch: b._id });
    const old = plan ? plan.topics.slice().sort((x, y) => x.order - y.order) : [];
    const byTitle = new Map(old.map(t => [t.title.trim().toLowerCase(), t]));
    const keep = (title, i) => {
      const prev = byTitle.get(title.trim().toLowerCase());
      return prev ? { _id: prev._id, title: prev.title, order: i, status: prev.status, completedOn: prev.completedOn }
                  : { title: title.trim(), order: i, status: 'pending' };
    };
    let topics;
    if (args.mode === 'append') {
      const fresh = args.topics.filter(t => !byTitle.has(t.trim().toLowerCase()));
      topics = [...old.map((t, i) => ({ _id: t._id, title: t.title, order: i, status: t.status, completedOn: t.completedOn })),
                ...fresh.map((t, j) => ({ title: t.trim(), order: old.length + j, status: 'pending' }))];
    } else topics = args.topics.map(keep);
    const removed = args.mode === 'replace' ? old.filter(t => !args.topics.some(n => n.trim().toLowerCase() === t.title.trim().toLowerCase())) : [];
    return {
      summary: `${args.mode === 'append' ? 'Add topics to' : 'Replace'} syllabus of "${b.name}" (${old.length} → ${topics.length} topics)`,
      changes: { added: topics.filter(t => !t._id).map(t => t.title), removed: removed.map(t => `${t.title} (${t.status})`), total: topics.length },
      warnings: removed.some(t => t.status === 'done') ? ['Some removed topics were already marked done — their progress will be lost.'] : [],
      apply: async () => ({ topics: unwrap(await ctx.api('PUT', `/api/plans/${b._id}`, { topics })).plan.topics.length }),
    };
  },
}));

module.exports = { adminTools };
