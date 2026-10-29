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
const Organization = require('../models/Organization');
const tenant   = require('../services/tenant');
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
// role / active as they are in THIS college (a person may work for several)
function withRole(u) {
  const m = u.membershipIn(tenant.currentOrg());
  u.role = m?.role || u.role;
  u.isActive = !!(u.isActive && m?.isActive);
  return u;
}
async function findUser(ref) {
  const r = String(ref || '').trim();
  if (!r) throw new ToolError('Say which user (email or name).');
  const here = User.inOrg(tenant.currentOrg());   // only people of this college
  if (/^[a-f0-9]{24}$/i.test(r)) { const u = await User.findOne({ _id: r, ...here }).select('-password'); if (u) return withRole(u); }
  if (r.includes('@')) {
    const u = await User.findOne({ email: r.toLowerCase(), ...here }).select('-password');
    if (!u) throw new ToolError(`No user with email ${r} in this college.`);
    return withRole(u);
  }
  const m = await User.find({ name: rx(r), ...here }).select('-password');
  if (m.length === 1) return withRole(m[0]);
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

// This college's sign-in page (its first web address).
async function loginUrl() {
  const o = await Organization.findById(tenant.currentOrg()).select('hosts').lean();
  const h = o?.hosts?.find(x => x.includes('.') && !/^\d/.test(x));
  return h ? `https://${h}/login` : '(your college web address)/login';
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
    const org = tenant.currentOrg();
    const users = (await User.find(User.inOrg(org)).select('-password').sort('name')).map(withRole)
      .filter(u => include_inactive || u.isActive);
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
    if (exists && exists.membershipIn(tenant.currentOrg()))
      throw new ToolError(`${email} already has an account here (${exists.name}). Use update_user instead.`);
    if (exists) return {
      summary: `Give ${exists.name} <${email}> (already has a login for another college) the ${role} role here`,
      changes: { email, role, password: 'unchanged — they keep their own password' }, warnings: [],
      apply: async () => ({ user: unwrap(await ctx.api('POST', '/api/auth/create-user', { name: exists.name, email, password: tempPassword(), role })).user,
        note: 'They sign in here with the password they already have.', loginUrl: await loginUrl() }),
    };
    const warnings = role === 'superadmin' ? ['A superadmin can see and change EVERYTHING, including other users.'] : [];
    return {
      summary: `Create ${role} account for ${args.name.trim()} <${email}>`,
      changes: { name: args.name.trim(), email, role, password: 'a temporary password will be generated and shown after saving' },
      warnings,
      apply: async () => {
        const password = tempPassword();
        const out = unwrap(await ctx.api('POST', '/api/auth/create-user', { name: args.name.trim(), email, password, role }));
        return { user: out.user, temporaryPassword: password, note: PW_NOTE, loginUrl: await loginUrl() };
      },
    };
  },
}));

admin(writeTool({
  name: 'sign_out_everywhere',
  title: 'Sign people out on every device',
  description: 'Superadmin only. Ends sign-ins so people must log in again — e.g. a shared or leaked password, a lost phone, someone who left. ' +
    'Give ONE of: user (email or name of one staff member), all_staff=true (every trainer/admin/management login of this college except you), ' +
    'all_students=true (every student who has set up). all_staff and all_students can be combined. Passwords do not change. ' +
    'The platform owner and people who also work for another college are not touched by all_staff. AI connections (tokens) keep working. ' +
    'To sign YOURSELF out of other devices use the website account menu ("Sign out other devices").',
  input: {
    user: z.string().optional().describe('Email or name of one staff member'),
    all_staff: z.boolean().optional(),
    all_students: z.boolean().optional(),
  },
  async plan(args, me, ctx) {
    const org = tenant.currentOrg();
    if (args.user && (args.all_staff || args.all_students)) throw new ToolError('Give either one user, or all_staff / all_students — not both.');
    if (args.user) {
      const u = await findUser(args.user);
      if (String(u._id) === String(me._id)) throw new ToolError('That is you. Use "Sign out other devices" in your account menu on the website.');
      if (u.platformOwner && !me.platformOwner) throw new ToolError('This is the platform owner\'s account. Only the platform owner can change it.');
      const shared = (u.memberships || []).some(m => String(m.org) !== String(org));
      return {
        summary: `Sign out ${u.name} <${u.email}> on every device`,
        changes: { user: u.name, email: u.email, role: u.role, password: 'unchanged' },
        warnings: shared ? [`${u.name} also works with another college; they are signed out there too.`] : [],
        apply: async () => unwrap(await ctx.api('POST', `/api/auth/users/${u._id}/sign-out`)),
      };
    }
    if (!args.all_staff && !args.all_students) throw new ToolError('Say who: user, all_staff and/or all_students.');
    const users = args.all_staff ? await User.find(User.inOrg(org)).select('name platformOwner memberships') : [];
    const staffCount = users.filter(u => String(u._id) !== String(me._id) && !u.platformOwner && !(u.memberships || []).some(m => String(m.org) !== String(org))).length;
    const studentCount = args.all_students ? await Student.countDocuments({ 'login.activatedAt': { $ne: null } }).setOptions({ withDemo: true }) : 0;
    return {
      summary: `Sign out ${[args.all_staff && `${staffCount} staff login(s)`, args.all_students && `${studentCount} student(s)`].filter(Boolean).join(' and ')} on every device`,
      changes: { staff: args.all_staff ? staffCount : 0, students: studentCount, you: 'stay signed in', passwords: 'unchanged' },
      warnings: ['Everyone listed has to sign in again with their password — tell them before you do this during class.'],
      apply: async () => unwrap(await ctx.api('POST', '/api/auth/sign-out-all', { staff: !!args.all_staff, students: !!args.all_students })),
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

// Cycles are created only through plan_cycles (mcp/opsTools.js → the cycle planner).

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

// ── Bulk back-filling (admin) ────────────────────────────────────────
const { upsertDailyLog } = require('../routes/logs').__shared;
const { saveCyclePlan }  = require('../routes/cycleplans').__shared;
const CyclePlanModel = require('../models/CyclePlan');
const DailyLogModel  = require('../models/DailyLog');
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

admin(writeTool({
  name: 'save_cycle_plan_bulk',
  title: 'Add many classes to a cycle plan',
  description:
    'Superadmin only. Add or update several classes of ONE cycle\'s class-by-class plan in one go (matched by class number; ' +
    'classes not listed are kept). remove_numbers deletes those classes from the plan. Use for back-filling or re-planning a ' +
    'whole cycle. For one class use save_cycle_plan_class.',
  input: {
    cycle_id: z.string(),
    classes: z.array(z.object({
      number: z.number().int().min(1).max(200),
      title: z.string().min(1).max(200),
      notes: z.string().max(2000).optional(),
      date: isoDate.optional(),
      time: z.string().max(20).optional(),
    })).max(60).default([]),
    remove_numbers: z.array(z.number().int().min(1).max(200)).max(60).optional().describe('Class numbers to delete from the plan'),
  },
  async plan(args, me) {
    requireId(args.cycle_id, 'cycle');
    const c = await Cycle.findById(args.cycle_id).populate('batch', 'name');
    if (!c) throw new ToolError('Cycle not found.');
    const nums = args.classes.map(x => x.number);
    if (new Set(nums).size !== nums.length) throw new ToolError('Each class number may appear only once.');
    const existing = await CyclePlanModel.findOne({ cycle: c._id }).lean();
    const byNum = new Map((existing?.classes || []).map(k => [k.number, k]));
    const remove = [...new Set(args.remove_numbers || [])];
    if (!args.classes.length && !remove.length) throw new ToolError('Give classes to add/update or remove_numbers to delete.');
    if (remove.some(n => nums.includes(n))) throw new ToolError('A class number cannot be both updated and removed.');
    const missing = remove.filter(n => !byNum.has(n));
    if (missing.length) throw new ToolError(`Not in the plan: class ${missing.join(', ')}`);
    const changes = [...args.classes.map(x => ({ number: x.number, date: x.date || '', title: x.title, action: byNum.has(x.number) ? 'update' : 'add' })),
      ...remove.map(n => ({ number: n, date: byNum.get(n).date || '', title: byNum.get(n).title, action: 'remove' }))];
    return {
      summary: `Cycle ${c.number} plan — ${c.batch.name}: ${changes.filter(x => x.action === 'add').length} new, ${changes.filter(x => x.action === 'update').length} updated${remove.length ? `, ${remove.length} removed` : ''}`,
      changes,
      apply: async () => {
        const merged = new Map((existing?.classes || []).map(k => [k.number, {
          number: k.number, title: k.title, notes: k.notes, trainer: k.trainer || null, date: k.date || '', time: k.time || '' }]));
        for (const x of args.classes) {
          const old = merged.get(x.number) || { trainer: null, time: '', notes: '', date: '' };
          merged.set(x.number, { ...old, number: x.number, title: x.title,
            notes: x.notes ?? old.notes, date: x.date ?? old.date, time: x.time ?? old.time });
        }
        for (const n of remove) merged.delete(n);
        const list = [...merged.values()].sort((a, b) => a.number - b.number);
        const r = await saveCyclePlan(me, c._id, list);
        if (r.status !== 200) throw new ToolError(r.body?.message || 'Could not save the plan.');
        return { totalClasses: r.body.classes.length };
      },
    };
  },
}));

admin(writeTool({
  name: 'save_daily_logs_bulk',
  title: 'Add many class logs to a batch',
  description:
    'Superadmin only. Create daily class logs (what was taught + status) for many dates of ONE batch in one go — for back-filling ' +
    'classes that were taught but never logged. No attendance is recorded. Dates that already have a log are SKIPPED (never ' +
    'overwritten) unless overwrite=true, which replaces only the notes and status (attendance is always kept). Future dates are refused.',
  input: {
    batch_id: z.string(),
    logs: z.array(z.object({
      date: isoDate,
      notes: z.string().min(1).max(3000),
      status: z.enum(['done', 'partial', 'not-covered']).optional(),
    })).min(1).max(80),
    overwrite: z.boolean().optional(),
  },
  async plan(args, me) {
    requireId(args.batch_id, 'batch');
    const b = await Batch.findById(args.batch_id).select('name');
    if (!b) throw new ToolError('Batch not found.');
    const dates = args.logs.map(l => l.date);
    if (new Set(dates).size !== dates.length) throw new ToolError('Each date may appear only once.');
    const future = dates.filter(d => d > todayIST());
    if (future.length) throw new ToolError(`Future dates are not allowed: ${future.join(', ')}`);
    const have = await DailyLogModel.find({ batch: b._id, date: { $in: dates.map(dayKey) } }).select('date notes topicsCovered prepLink').lean();
    const haveSet = new Map(have.map(h => [ymd(h.date), h]));
    const changes = args.logs.map(l => ({
      date: l.date, notes: l.notes.slice(0, 80) + (l.notes.length > 80 ? '…' : ''),
      action: haveSet.has(l.date) ? (args.overwrite ? 'overwrite notes' : 'skip (already logged)') : 'add',
    }));
    const todo = args.logs.filter(l => !haveSet.has(l.date) || args.overwrite);
    if (!todo.length) throw new ToolError('Every date already has a log. Nothing to add.');
    return {
      summary: `${b.name}: ${todo.length} class log(s) to save, ${args.logs.length - todo.length} skipped`,
      changes,
      apply: async () => {
        let saved = 0;
        for (const l of todo) {
          const old = haveSet.get(l.date);
          // an overwrite keeps the topics + prep link already on that day
          const r = await upsertDailyLog(me, { batch: b._id, date: l.date, notes: l.notes, status: l.status || 'done',
            ...(old ? { topicsCovered: old.topicsCovered, prepLink: old.prepLink } : {}) });
          if (r.status !== 200 && r.status !== 201) throw new ToolError(`${l.date}: ${r.body?.message || 'could not save'} (saved ${saved} before this)`);
          saved++;
        }
        return { logsSaved: saved };
      },
    };
  },
}));

admin(writeTool({
  name: 'set_cycle_accountability',
  title: 'Set deadline / on-time record for a cycle',
  description:
    'Superadmin only. Trainer Performance settings for one batch\'s cycle: turn tracking on/off, set the project day and the deadline ' +
    '(India time; empty = default Saturday after the project day, 7 PM), excuse a batch with a visible reason, and record WHEN each ' +
    'piece of cycle work was completed and BY WHOM — report (cycle form), marks, top3, plan. Use completions for cycles finished ' +
    'before tracking existed. done_by "trainer" credits the batch trainer (give trainer_name if the batch has several); ' +
    'Also sets the cycle LEAD trainer and the OWNER of each task (only the owner is scored for it; default owner = lead). ' +
    '"admin" means an admin did it and the trainer gets no credit. completed_at "" clears that record.',
  input: {
    cycle_id: z.string(),
    tracked: z.boolean().optional(),
    project_date: isoDate.optional(),
    deadline: z.string().regex(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})?$/).optional().describe('YYYY-MM-DDTHH:mm India time, or "" for the default'),
    excuse_note: z.string().max(300).optional().describe('"" removes the excuse'),
    lead_trainer: z.string().optional().describe('Name of the batch trainer who leads this cycle ("" = default: first trainer)'),
    owners: z.array(z.object({
      item: z.enum(['report', 'marks', 'top3', 'plan']),
      trainer_name: z.string().describe('"" = back to the lead'),
    })).max(4).optional().describe('Who must do each task; default is the lead'),
    completions: z.array(z.object({
      item: z.enum(['report', 'marks', 'top3', 'plan']),
      completed_at: z.string().regex(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})?$/).describe('YYYY-MM-DDTHH:mm India time, or "" to clear'),
      done_by: z.enum(['trainer', 'admin']).optional(),
      trainer_name: z.string().optional(),
    })).max(4).optional(),
  },
  async plan(args, me, ctx) {
    requireId(args.cycle_id, 'cycle');
    const c = await Cycle.findById(args.cycle_id)
      .populate({ path: 'batch', select: 'name trainers', populate: { path: 'trainers', select: 'name isActive role' } });
    if (!c) throw new ToolError('Cycle not found.');
    const body = {}, changes = [];
    const fmt = (d) => d ? new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') + ' IST' : 'default';
    if (args.tracked !== undefined) { body.tracked = args.tracked; changes.push({ field: 'tracked', from: !!c.track?.tracked, to: args.tracked }); }
    if (args.project_date !== undefined) { body.projectDate = args.project_date; changes.push({ field: 'project_date', from: c.track?.projectDate ? ymd(c.track.projectDate) : `default (${ymd(c.endDate)})`, to: args.project_date }); }
    if (args.deadline !== undefined) { body.deadline = args.deadline; changes.push({ field: 'deadline', from: fmt(c.track?.deadline), to: args.deadline ? args.deadline.replace('T', ' ') + ' IST' : 'default (Saturday after project day, 7 PM)' }); }
    if (args.excuse_note !== undefined) { body.excusedNote = args.excuse_note; changes.push({ field: 'excuse', from: c.track?.excusedNote || '', to: args.excuse_note }); }
    const elig = (c.batch?.trainers || []).filter(t => t.isActive !== false && !/\(review\)/i.test(t.name));
    const pickT = (name) => {
      const m = elig.filter(t => rx(name).test(t.name));
      if (m.length !== 1) throw new ToolError(`"${name}" must match exactly one trainer of ${c.batch.name}: ${elig.map(t => t.name).join(', ') || 'none'}.`);
      return m[0];
    };
    if (args.lead_trainer !== undefined) {
      const t = args.lead_trainer ? pickT(args.lead_trainer) : null;
      body.lead = t ? String(t._id) : null;
      changes.push({ field: 'lead', from: elig.find(x => String(x._id) === String(c.track?.lead))?.name || 'default (first trainer)', to: t ? t.name : 'default (first trainer)' });
    }
    if (args.owners?.length) {
      body.owners = {};
      for (const o of args.owners) {
        const t = o.trainer_name ? pickT(o.trainer_name) : null;
        body.owners[o.item] = t ? String(t._id) : null;
        changes.push({ field: `owner of ${o.item}`, from: elig.find(x => String(x._id) === String(c.track?.owners?.[o.item]))?.name || 'lead', to: t ? t.name : 'lead' });
      }
    }
    if (args.completions?.length) {
      body.stamps = {};
      const trainers = (c.batch?.trainers || []).filter(t => t.isActive !== false && !/\(review\)/i.test(t.name));
      for (const x of args.completions) {
        if (!x.completed_at) { body.stamps[x.item] = null; changes.push({ field: x.item, from: c.track?.[x.item]?.at ? fmt(c.track[x.item].at) : 'none', to: 'cleared' }); continue; }
        let by, admin = x.done_by === 'admin';
        if (admin) by = me._id;
        else {
          const pick = x.trainer_name ? trainers.find(t => rx(x.trainer_name).test(t.name)) : (trainers.length === 1 ? trainers[0] : null);
          if (!pick) throw new ToolError(`${c.batch.name} has ${trainers.length} trainer(s) (${trainers.map(t => t.name).join(', ') || 'none'}). Say which one with trainer_name.`);
          by = pick._id;
        }
        body.stamps[x.item] = { at: x.completed_at, by, admin };
        const who = admin ? `admin (${me.name})` : trainers.find(t => String(t._id) === String(by)).name;
        changes.push({ field: x.item, from: c.track?.[x.item]?.at ? fmt(c.track[x.item].at) : 'none', to: `${x.completed_at.replace('T', ' ')} IST by ${who}` });
      }
    }
    if (!changes.length) throw new ToolError('Nothing to change.');
    return {
      summary: `Trainer Performance settings — Cycle ${c.number}, ${c.batch?.name}`, changes,
      apply: async () => { const out = unwrap(await ctx.api('PATCH', `/api/performance/cycle/${c._id}`, body)); return { deadline: fmt(out.deadline) }; },
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
    'flagged (resolve on the Duplicates page). A student with no roll yet (lateral entry, late admission) gets a temporary ID ' +
    '(TMP-XXXXX) to sign in with — give it to them; when the real roll arrives, change it with edit_student. Trainers can add only to their own batches. Max 1000 per call.',
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
        ...(pv.temporaryIds ? [`${pv.temporaryIds} student(s) have no roll — each gets a temporary ID (TMP-…) to sign in with.`] : []),
      ],
      apply: async () => {
        const out = unwrap(await ctx.api('POST', '/api/students/bulk', { batch: b._id, rows: args.students }));
        return { added: out.imported, skipped: out.skippedCount, flaggedDuplicates: out.duplicateCount,
          ...(out.temporaryIds?.length ? { temporaryIds: out.temporaryIds, note: 'Give each student their temporary ID; they sign in with it and the batch code.' } : {}) };
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
    demo: z.boolean().optional().describe('Superadmin only. A demo/review account: left out of rosters, counts, marks, attendance and Top 3; nothing it answers is saved.'),
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
    if (args.demo !== undefined && me.role !== 'superadmin') throw new ToolError('Only the admin can make a demo account.');
    const body = {}, changes = [];
    const map = { name: 'name', new_roll: 'roll', course: 'course', sem: 'sem', section: 'section', year: 'year', flagged: 'flagged', demo: 'demo' };
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
    const clash = s.roll ? await Student.findOne({ batch: to._id, roll: new RegExp(`^\\s*${s.roll.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }) : null;
    if (clash) throw new ToolError(`${to.name} already has roll ${s.roll} (${clash.name}). If they are the same person, use merge_students.`);
    return {
      summary: `Move ${s.name} (${s.roll}) → ${to.name}`,
      changes: { from: s.batch?.name, to: to.name },
      warnings: [],
      apply: async () => { unwrap(await ctx.api('POST', `/api/students/${s._id}/move`, { batch: to._id })); return { movedTo: to.name }; },
    };
  },
}));

anyone(writeTool({
  name: 'remove_student',
  title: 'Remove students from a batch',
  description: 'Admin, or a trainer of that batch (not co-trainers). Removes one or more student records — e.g. a student wrongly listed in a ' +
    'second track, or someone who left. Their attendance ticks, class check-ins and project submissions in that batch go with the record; ' +
    'a record of the same student in another batch is not touched. A record that has real marks or a Top-3 place is refused ' +
    '(if the same roll is in the batch twice, use merge_students instead) unless an admin passes force=true, which deletes those marks too. ' +
    'Cannot be undone. Find student ids with get_batch_roster or search.',
  input: {
    student_ids: z.array(z.string()).min(1).max(50).describe('Student record ids (the record in the batch you want them OUT of)'),
    force: z.boolean().optional().describe('Admin only: also delete their marks / Top-3 places in this batch'),
  },
  async plan(args, me, ctx) {
    const ids = [...new Set(args.student_ids.map(String))];
    ids.forEach(id => requireId(id, 'student'));
    if (args.force && me.role !== 'superadmin') throw new ToolError('Only the admin can use force.');
    const CycleMark = require('../models/CycleMark');
    const DailyLog = require('../models/DailyLog');
    const students = await Student.find({ _id: { $in: ids } }).select('name roll batch login.activatedAt').populate('batch', 'name').setOptions({ withDemo: true });
    const missing = ids.filter(id => !students.some(s => String(s._id) === id));
    if (missing.length) throw new ToolError(`Not found: ${missing.join(', ')}`);
    const problems = [], rows = [], warnings = ['This cannot be undone.'];
    for (const s of students) {
      if (!(await canAccessBatch(me, s.batch?._id))) { problems.push(`${s.name} (${s.roll}) is not in your batch`); continue; }
      const marks = await CycleMark.countDocuments({ student: s._id, $or: [{ status: 'evaluated' }, { assessment: { $ne: null } }, { project: { $ne: null } }] });
      const tops = await Cycle.countDocuments({ 'report.top3.student': s._id });
      const logs = await DailyLog.find({ 'attendance.student': s._id }).select('attendance').lean();
      const present = logs.filter(l => l.attendance.some(a => String(a.student) === String(s._id) && a.present)).length;
      const elsewhere = s.roll ? await Student.find({ roll: new RegExp(`^\\s*${s.roll.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), _id: { $ne: s._id } })
        .select('batch').populate('batch', 'name').lean() : [];
      const sameBatch = elsewhere.some(o => String(o.batch?._id) === String(s.batch?._id));
      if ((marks || tops) && !args.force)
        problems.push(`${s.name} (${s.roll}) has ${marks} mark(s)${tops ? ` and ${tops} Top-3 place(s)` : ''} in ${s.batch?.name}` +
          (sameBatch ? ' and is in this batch twice — use merge_students' : ' — an admin can pass force=true to delete them anyway'));
      if (marks || tops) warnings.push(`${s.name}: ${marks} mark(s)${tops ? `, ${tops} Top-3 place(s)` : ''} will be deleted.`);
      if (s.login?.activatedAt) warnings.push(`${s.name} had set up a student sign-in on this record; it will stop working.`);
      if (!elsewhere.length) warnings.push(`${s.name} (${s.roll}) is in no other batch — after this they are not on the platform at all.`);
      rows.push({ id: String(s._id), name: s.name, roll: s.roll, batch: s.batch?.name, presentDays: present, marks, top3: tops,
        alsoIn: [...new Set(elsewhere.map(o => o.batch?.name).filter(Boolean))] });
    }
    if (problems.length) throw new ToolError('Nothing removed — ' + problems.join('; '));
    return {
      summary: `Remove ${rows.length} student record(s): ${rows.map(r => `${r.name} (${r.roll}) from ${r.batch}`).join(', ')}`,
      changes: rows, warnings,
      apply: async () => {
        const done = [];
        for (const r of rows) {
          unwrap(await ctx.api('DELETE', `/api/students/${r.id}${args.force ? '?force=1' : ''}`));
          done.push(`${r.name} (${r.roll}) removed from ${r.batch}`);
        }
        return { removed: done };
      },
    };
  },
}));

admin({
  name: 'list_duplicate_students',
  title: 'Find duplicate roll numbers',
  description: 'Superadmin only. Roll numbers that appear more than once in the active semester — inside one batch (a double import: ' +
    'merge them with merge_students) or across batches (same student in two tracks). Shows names, marks and attendance per record.',
  input: {},
  async handler(args, me, ctx) {
    const sem = await Semester.findOne({ status: 'active' });
    const out = unwrap(await ctx.api('GET', `/api/students/duplicates${sem ? `?semester=${sem._id}` : ''}`));
    return { semester: sem?.name || null, count: out.count, groups: out.groups };
  },
});

anyone(writeTool({
  name: 'merge_students',
  title: 'Merge two records of the same student',
  description: 'Admin, or a trainer of that batch. When one student was added twice to the SAME batch (same roll, maybe a misspelt name), move everything ' +
    'from the duplicate record — marks, attendance, class check-ins, project submissions, feedback votes, Top-3 places, sign-in, photo — ' +
    'to the record you keep, then remove the duplicate. Where both have a mark for the same cycle, the evaluated one wins; attendance: present wins. ' +
    'Cannot be undone. Use list_duplicate_students to find pairs.',
  input: { keep_student_id: z.string().describe('The record to keep (correct name)'), duplicate_student_id: z.string().describe('The record to remove') },
  async plan(args, me, ctx) {
    requireId(args.keep_student_id, 'student'); requireId(args.duplicate_student_id, 'student');
    const p = unwrap(await ctx.api('POST', `/api/students/${args.duplicate_student_id}/merge`, { into: args.keep_student_id, preview: true }));
    const warnings = ['This cannot be undone.'];
    if (p.keep.name.trim().toLowerCase() !== p.drop.name.trim().toLowerCase()) warnings.push(`Names differ: keeping "${p.keep.name}", removing "${p.drop.name}". Make sure they are the same person.`);
    if (p.keep.roll.trim().toLowerCase() !== p.drop.roll.trim().toLowerCase()) warnings.push(`Roll numbers differ (${p.keep.roll} / ${p.drop.roll}).`);
    return {
      summary: `Merge ${p.drop.name} (${p.drop.roll}) into ${p.keep.name} (${p.keep.roll})`,
      changes: { keep: p.keep, remove: p.drop, moves: p.moves }, warnings,
      apply: async () => unwrap(await ctx.api('POST', `/api/students/${args.duplicate_student_id}/merge`, { into: args.keep_student_id })),
    };
  },
}));

admin(writeTool({
  name: 'set_top_student_rules',
  title: 'Change how top students are scored',
  description: 'Superadmin only. Weights (0–100) of the top-student score — marks, attendance, projects — and the score cut-offs for ' +
    'the "Good" and "Excellent" labels. Weights are relative (60/25/15 = 12/5/3). Leave out what should stay the same.',
  input: {
    marks: z.number().min(0).max(100).optional(), attendance: z.number().min(0).max(100).optional(), projects: z.number().min(0).max(100).optional(),
    good: z.number().min(0).max(100).optional(), excellent: z.number().min(0).max(100).optional(),
  },
  async plan(args, me, ctx) {
    const now = unwrap(await ctx.api('GET', '/api/settings/student-score')).studentScore;
    const next = { ...now };
    const changes = [];
    for (const k of ['marks', 'attendance', 'projects', 'good', 'excellent'])
      if (args[k] !== undefined && args[k] !== now[k]) { next[k] = args[k]; changes.push({ field: k, from: now[k], to: args[k] }); }
    if (!changes.length) throw new ToolError('Nothing to change.');
    return {
      summary: 'Change top-student scoring', changes, warnings: [],
      apply: async () => unwrap(await ctx.api('PUT', '/api/settings/student-score', next)),
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
