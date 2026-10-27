// ─────────────────────────────────────────────────────────────────────
//  Skill Lab MCP tools — ROUND 4: OPERATIONS
//  Planning cycles, holidays, timetables, meetings + notes, student access,
//  project submission switch, trainer feedback, plan editing lock.
//
//  Every tool is a thin wrapper over the EXISTING website route (ctx.api, as
//  the signed-in user). No rule lives here — permissions, validation and
//  side-effects are exactly the website's. Write tools: preview → yes → save.
// ─────────────────────────────────────────────────────────────────────
const { z }  = require('zod');
const { ToolError } = require('./tools');
const { writeTool, unwrap } = require('./writeTools');

const opsTools = [];
const anyone = (t) => opsTools.push(t);
const admin  = (t) => opsTools.push({ ...t, admin: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD');
const objId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be an id');
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const qs = (o) => { const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''); return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : ''; };
const read = (def) => ({ ...def, async handler(args, user, ctx) { return def.run(args, ctx.api); } });

// ── Reads ────────────────────────────────────────────────────────────
anyone(read({
  name: 'get_meeting_day',
  title: 'Daily review (after classes)',
  description: 'For one day (default today, India time): every batch that had a class — what was planned, what the trainer logged ' +
    '(which planned class, done/partly/not, notes, GitHub push, attendance), what students said (covered %, understanding /5, and a ' +
    'mismatch flag when the log says done but most students say not covered), holidays, plus the day\'s meeting notes and still-open notes.',
  input: { date: isoDate.optional(), batch_id: objId.optional().describe('Only this batch') },
  async run(a, api) {
    const d = unwrap(await api('GET', '/api/meeting/day' + qs({ date: a.date })));
    if (a.batch_id) { d.batches = d.batches.filter(b => String(b.batchId) === a.batch_id); d.notes = d.notes.filter(n => !n.batch || String(n.batch._id) === a.batch_id); }
    return d;
  },
}));

anyone(read({
  name: 'get_class_health',
  title: 'Class health (day, week or cycle)',
  description: 'Every planned class of every batch between from and to (default today; up to 120 days): its state (done / partly / not done / ' +
    'missing / holiday / upcoming), whether the log was on time and complete, attendance, what students said (covered %, understanding /5) and ' +
    'flags (late log, incomplete log, not logged, students disagree, low attendance, more answers than present). Summed per batch and overall. ' +
    'Filter by batch_ids or a trainer. For a whole cycle, pass that cycle\'s start and end dates (the result lists cycle periods to pick from).',
  input: { from: isoDate.optional(), to: isoDate.optional(), batch_ids: z.array(objId).max(40).optional(), trainer_id: objId.optional() },
  async run(a, api) {
    return unwrap(await api('GET', '/api/meeting/health' + qs({ from: a.from, to: a.to, batches: (a.batch_ids || []).join(','), trainer: a.trainer_id })));
  },
}));

anyone(read({
  name: 'get_cycle_review',
  title: 'Cycle review (per trainer)',
  description: 'End-of-cycle review for one deadline period (default: the latest tracked one): per trainer and batch — score and parts, ' +
    'plan delivery (classes due, not logged, done/partly/not), marks spread by category, project submissions, student understanding, ' +
    'feedback average, plus meeting notes about that trainer.',
  input: { deadline_date: isoDate.optional(), trainer: z.string().optional().describe('Trainer name (part of it is fine)') },
  async run(a, api) {
    const d = unwrap(await api('GET', '/api/meeting/review' + qs({ period: a.deadline_date })));
    if (a.trainer) d.trainers = d.trainers.filter(t => t.name.toLowerCase().includes(a.trainer.toLowerCase()));
    return d;
  },
}));

anyone(read({
  name: 'list_meeting_notes',
  title: 'Meeting notes',
  description: 'Notes from daily reviews (scope "day") or cycle reviews (scope "cycle"). Filter by date, deadline period, batch or status.',
  input: { scope: z.enum(['day', 'cycle']).optional(), date: isoDate.optional(), deadline_date: isoDate.optional(),
    batch_id: objId.optional(), status: z.enum(['open', 'done']).optional() },
  async run(a, api) { return unwrap(await api('GET', '/api/meeting/notes' + qs({ scope: a.scope, date: a.date, period: a.deadline_date, batch: a.batch_id, status: a.status }))); },
}));

anyone(read({
  name: 'list_holidays',
  title: 'Holidays',
  description: 'Holidays / no-class days of the active semester: dates, reason, which batches, and how many classes were moved.',
  input: {},
  async run(_a, api) { return unwrap(await api('GET', '/api/settings/holidays')); },
}));

anyone(read({
  name: 'get_student_access',
  title: 'Student sign-in status of a batch',
  description: 'How students of a batch set up their sign-in, and who has set up / last signed in. ' +
    'mode "personal" (default): each student not set up yet has their own setup code (setupCode) — hand each student theirs. ' +
    'mode "batch": one batch join code (joinCode) for everyone. Management (read-only) does not see codes.',
  input: { batch_id: objId },
  async run(a, api) { return unwrap(await api('GET', `/api/student-admin/batch/${a.batch_id}`)); },
}));

anyone(read({
  name: 'get_project_submissions',
  title: 'Project submissions of a cycle',
  description: 'Whether student project submission is open, and every submission (GitHub, live link, pasted code files with line counts, late flag) for one cycle. ' +
    'To read a student\'s pasted code, use get_submission_code with the submission _id.',
  input: { cycle_id: objId },
  async run(a, api) { return unwrap(await api('GET', `/api/student-admin/cycle/${a.cycle_id}/submissions`)); },
}));

anyone(read({
  name: 'get_submission_code',
  title: 'Code a student pasted with their project',
  description: 'The code files (name, language, code) a student pasted in their project submission — e.g. to review or check it. Give the submission _id from get_project_submissions.',
  input: { submission_id: objId },
  async run(a, api) { return unwrap(await api('GET', `/api/student-admin/submission/${a.submission_id}/code`)); },
}));

anyone(read({
  name: 'get_feedback_results',
  title: 'Student feedback on trainers',
  description: 'Feedback forms and their results. Without window_id: the list of forms. With it: averages per trainer and batch ' +
    '(trainers see only their own, and only with 5+ answers; the admin also sees comments — never names).',
  input: { window_id: objId.optional() },
  async run(a, api) {
    return a.window_id ? unwrap(await api('GET', `/api/feedback/windows/${a.window_id}/results`)) : unwrap(await api('GET', '/api/feedback/windows'));
  },
}));

admin(read({
  name: 'get_timetables',
  title: 'Batch timetables',
  description: 'Superadmin only. Each batch\'s class days, and whether they are confirmed ("saved") or only guessed from the plans.',
  input: {},
  async run(_a, api) { return unwrap(await api('GET', '/api/settings/timetables')); },
}));

// ── Writes: anyone (scoped by the website rules) ─────────────────────
anyone(writeTool({
  name: 'add_meeting_note',
  title: 'Add a meeting note',
  description: 'Add a note in a daily review (scope "day", give date) or a cycle review (scope "cycle", give deadline_date). ' +
    'Attach it to a batch and/or a trainer. Trainers can add notes only for their own batches. The trainer concerned can see it.',
  input: { scope: z.enum(['day', 'cycle']), date: isoDate.optional(), deadline_date: isoDate.optional(),
    batch_id: objId.optional(), trainer_id: objId.optional(), text: z.string().min(1).max(2000) },
  async plan(a, user, ctx) {
    if (a.scope === 'day' && !a.date) throw new ToolError('A day note needs date.');
    if (a.scope === 'cycle' && !a.deadline_date) throw new ToolError('A cycle note needs deadline_date.');
    return { summary: `Add ${a.scope} note: "${a.text.slice(0, 80)}"`, changes: a,
      apply: async () => unwrap(await ctx.api('POST', '/api/meeting/notes', { scope: a.scope, date: a.date, period: a.deadline_date, batchId: a.batch_id, trainerId: a.trainer_id, text: a.text })) };
  },
}));

anyone(writeTool({
  name: 'update_meeting_note',
  title: 'Mark a meeting note done / edit it',
  description: 'Mark a note done (or reopen it), or change its text (author or admin only).',
  input: { note_id: objId, status: z.enum(['open', 'done']).optional(), text: z.string().max(2000).optional() },
  async plan(a, user, ctx) {
    if (!a.status && a.text === undefined) throw new ToolError('Give status or text.');
    return { summary: `Update note ${a.note_id}`, changes: { status: a.status, text: a.text },
      apply: async () => unwrap(await ctx.api('PATCH', `/api/meeting/notes/${a.note_id}`, { status: a.status, text: a.text })) };
  },
}));

anyone(writeTool({
  name: 'set_project_submission',
  title: 'Open / close student project submission',
  description: 'The trainer\'s switch for one cycle. open=true opens it now (until midnight India time, or for `minutes`); ' +
    'open=false closes it. Students submit GitHub + live link + screenshot from their own page while it is open.',
  input: { cycle_id: objId, open: z.boolean(), minutes: z.number().int().min(5).max(720).optional() },
  async plan(a, user, ctx) {
    return { summary: a.open ? `Open submission${a.minutes ? ` for ${a.minutes} min` : ' until midnight'}` : 'Close submission', changes: a,
      apply: async () => unwrap(await ctx.api('POST', `/api/student-admin/cycle/${a.cycle_id}/submission`, { open: a.open, minutes: a.minutes })) };
  },
}));

anyone(writeTool({
  name: 'reset_student_password',
  title: 'Reset a student\'s sign-in',
  description: 'Clears the student\'s password and signs them out everywhere. Returns a new personal setup code (setupCode) to hand the student ' +
    '(in batch mode they use the batch join code). They then set up again with roll number + code + a new password.',
  input: { student_id: objId },
  async plan(a, user, ctx) {
    return { summary: `Reset sign-in of student ${a.student_id}`, changes: a,
      apply: async () => unwrap(await ctx.api('POST', `/api/student-admin/student/${a.student_id}/reset-password`)) };
  },
}));

anyone(writeTool({
  name: 'new_join_code',
  title: 'New batch join code',
  description: 'Replace a batch\'s student join code (the old one stops working; students already set up are not affected).',
  input: { batch_id: objId },
  async plan(a, user, ctx) {
    return { summary: `New join code for batch ${a.batch_id}`, changes: a,
      apply: async () => unwrap(await ctx.api('POST', `/api/student-admin/batch/${a.batch_id}/join-code`)) };
  },
}));

// ── Writes: superadmin ───────────────────────────────────────────────
admin(writeTool({
  name: 'set_student_signup',
  title: 'How students set up their sign-in',
  description: 'personal (safer, default): each student gets their own setup code from the trainer. ' +
    'batch: one join code per batch — easier, but anyone with the code and a roll number can claim that student.',
  input: { mode: z.enum(['personal', 'batch']) },
  async plan(a, user, ctx) {
    return { summary: `Student sign-up: ${a.mode === 'personal' ? 'personal setup codes' : 'one batch join code'}`, changes: a,
      apply: async () => unwrap(await ctx.api('PUT', '/api/settings/student-signup', { mode: a.mode })) };
  },
}));

const groupSchema = z.object({
  name: z.string().max(60).optional(),
  batch_ids: z.array(objId).min(1).max(40),
  start_date: isoDate, end_date: isoDate,
  project_day: isoDate.optional().describe('Default: the last class day'),
  project_days: z.array(z.object({ batch_id: objId, date: isoDate })).max(40).optional().describe('Per-batch project day'),
});
const holidaySchema = z.object({ from: isoDate, to: isoDate.optional(), title: z.string().max(80), batch_ids: z.array(objId).max(40).optional().describe('Empty = all batches') });
const toPlanner = (a) => ({
  groups: a.groups.map(g => ({ name: g.name, batchIds: g.batch_ids, start: g.start_date, end: g.end_date, projectDay: g.project_day,
    projectDays: Object.fromEntries((g.project_days || []).map(p => [p.batch_id, p.date])) })),
  holidays: (a.holidays || []).map(h => ({ from: h.from, to: h.to || h.from, title: h.title, batchIds: h.batch_ids || [] })),
});

admin(writeTool({
  name: 'plan_cycles',
  title: 'Plan new cycles (the cycle planner)',
  description: 'Superadmin only. THE way to create cycles. Give groups of batches with a start and end date (groups can differ, e.g. ' +
    '1st year vs others), optional project day per group or per batch, and optional new holidays. Each batch gets its next cycle ' +
    'number, class days from its CONFIRMED timetable minus holidays, and dated empty plan rows (numbered on from its last class) for ' +
    'trainers to fill. Anything that would break later (overlap, unconfirmed timetable, project day not a class day) is refused.',
  input: { groups: z.array(groupSchema).min(1).max(10), holidays: z.array(holidaySchema).max(10).optional() },
  async plan(a, user, ctx) {
    const p = unwrap(await ctx.api('POST', '/api/cycles/planner/preview', toPlanner(a)));
    const problems = [...p.errors, ...p.batches.flatMap(b => b.errors.map(e => `${b.batch}: ${e}`))];
    if (!p.ok) throw new ToolError('Cannot create yet — ' + problems.join(' | '));
    return {
      summary: `Create ${p.batches.length} cycle(s)${p.holidays.length ? ` and ${p.holidays.length} holiday(s)` : ''}`,
      changes: p.batches.map(b => ({ batch: b.batch, group: b.group, cycle: b.number, dates: `${b.start} – ${b.end}`, classDays: b.classDays.length,
        classes: `${b.firstClass}–${b.lastClass}`, projectDay: b.projectDay, holidays: b.holidays.map(h => `${h.date} ${h.title}`) })),
      warnings: [...p.batches.flatMap(b => b.warnings.map(w => `${b.batch}: ${w}`)),
        ...p.affected.map(x => `${x.batch}: existing class ${x.number} on ${x.date} falls on new holiday "${x.holiday}" — re-plan it`)],
      apply: async () => unwrap(await ctx.api('POST', '/api/cycles/planner', toPlanner(a))),
    };
  },
}));

admin(writeTool({
  name: 'set_timetable',
  title: 'Set a batch\'s class days',
  description: 'Superadmin only. Confirm which weekdays a batch has class (used for holiday moves and the cycle planner).',
  input: { batch_id: objId, days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1).max(7) },
  async plan(a, user, ctx) {
    return { summary: `Class days: ${a.days.join(', ')}`, changes: a,
      apply: async () => unwrap(await ctx.api('PUT', `/api/settings/timetables/${a.batch_id}`, { days: a.days.map(d => DAYS[d]) })) };
  },
}));

admin(writeTool({
  name: 'add_holiday',
  title: 'Mark a holiday',
  description: 'Superadmin only. Mark a day or range as holiday for all batches (or batch_ids). Four modes: ' +
    '"shift" moves planned classes from that day on to each batch\'s next class days (cycle end / project day / deadline move if needed; refused if it would run into ' +
    'the next cycle or a timetable is only guessed). "keep" moves classes forward too but keeps the project day and cycle end: a class that no longer fits ' +
    'is merged into the last class before the project day. "makeup" (one day only) moves that day\'s classes to makeup_date instead, e.g. Monday\'s classes held ' +
    'on Saturday; nothing else moves. "mark" moves nothing and flags those classes for re-planning. ' +
    'Holiday days never count against anyone. A day already marked: undo_holiday first, then mark it again in the new mode.',
  input: { from: isoDate, to: isoDate.optional(), title: z.string().min(1).max(80), batch_ids: z.array(objId).max(40).optional(),
    mode: z.enum(['shift', 'mark', 'keep', 'makeup']), makeup_date: isoDate.optional().describe('mode makeup: the date the classes happen instead') },
  async plan(a, user, ctx) {
    const body = { from: a.from, to: a.to || a.from, title: a.title, batchIds: a.batch_ids || [], mode: a.mode, makeupDate: a.makeup_date || null };
    const p = unwrap(await ctx.api('POST', '/api/settings/holidays/preview', body));
    if (!p.ok) throw new ToolError('Cannot do this — ' + p.batches.filter(b => b.conflict).map(b => `${b.batch}: ${b.conflict}`).join(' | '));
    return {
      summary: `${a.title}: ${body.from}${body.to !== body.from ? ' – ' + body.to : ''} (${{ shift: 'move classes forward', keep: 'move forward, keep project day', makeup: `classes held on ${body.makeupDate}`, mark: 'mark only' }[a.mode]})`,
      changes: p.batches.filter(b => b.moves.length || (b.merges || []).length || b.onHoliday.length || b.cycleChanges.length).map(b => ({ batch: b.batch,
        moves: b.moves.map(m => `class ${m.number}: ${m.from} → ${m.to}`),
        merges: (b.merges || []).map(g => `class ${g.removed.map(x => x.number).join(', ')} merged into class ${g.into} (${g.date})`),
        needsReplanning: b.onHoliday.map(m => `class ${m.number} on ${m.date}`),
        cycleChanges: b.cycleChanges })),
      warnings: p.batches.filter(b => b.note).map(b => `${b.batch}: ${b.note}`),
      apply: async () => unwrap(await ctx.api('POST', '/api/settings/holidays', body)),
    };
  },
}));

admin(writeTool({
  name: 'undo_holiday',
  title: 'Undo a holiday',
  description: 'Superadmin only. Removes a holiday and moves the classes it moved back to their old dates (where nobody changed them since).',
  input: { holiday_id: objId },
  async plan(a, user, ctx) {
    const list = unwrap(await ctx.api('GET', '/api/settings/holidays')).holidays;
    const h = list.find(x => String(x._id) === a.holiday_id);
    if (!h) throw new ToolError('Holiday not found.');
    return { summary: `Remove "${h.title}" (${h.from}${h.to !== h.from ? ' – ' + h.to : ''})${h.moved ? ` and move ${h.moved} class(es) back` : ''}`, changes: h,
      apply: async () => unwrap(await ctx.api('DELETE', `/api/settings/holidays/${a.holiday_id}`)) };
  },
}));

admin(writeTool({
  name: 'open_feedback',
  title: 'Open student feedback on trainers',
  description: 'Superadmin only. Students of these batches can rate each of their trainers (anonymous) for `hours` (default 48).',
  input: { batch_ids: z.array(objId).min(1).max(40), hours: z.number().int().min(1).max(336).optional(), title: z.string().max(100).optional() },
  async plan(a, user, ctx) {
    return { summary: `Open "${a.title || 'Trainer feedback'}" for ${a.batch_ids.length} batch(es), ${a.hours || 48} h`, changes: a,
      apply: async () => unwrap(await ctx.api('POST', '/api/feedback/windows', { batchIds: a.batch_ids, hours: a.hours || 48, title: a.title })) };
  },
}));

admin(writeTool({
  name: 'close_feedback',
  title: 'Close / extend a feedback form',
  description: 'Superadmin only. close=true closes it now; otherwise extend it by `hours` from now.',
  input: { window_id: objId, close: z.boolean().optional(), hours: z.number().int().min(1).max(336).optional() },
  async plan(a, user, ctx) {
    if (!a.close && !a.hours) throw new ToolError('Give close=true or hours.');
    return { summary: a.close ? 'Close feedback now' : `Keep open ${a.hours} more hour(s)`, changes: a,
      apply: async () => unwrap(await ctx.api('PATCH', `/api/feedback/windows/${a.window_id}`, a.close ? { close: true } : { hours: a.hours })) };
  },
}));

admin(writeTool({
  name: 'set_plan_editing',
  title: 'Let trainers edit plans / lock them',
  description: 'Superadmin only. Open or lock plan editing for trainers — for one cycle (cycle_id) or every cycle of a deadline period ' +
    '(deadline_date). Complete plans are locked for trainers unless opened here.',
  input: { open: z.boolean(), cycle_id: objId.optional(), deadline_date: isoDate.optional() },
  async plan(a, user, ctx) {
    if (!a.cycle_id === !a.deadline_date) throw new ToolError('Give either cycle_id or deadline_date.');
    return { summary: `${a.open ? 'Open' : 'Lock'} plan editing for ${a.cycle_id ? 'one cycle' : `period ${a.deadline_date}`}`, changes: a,
      apply: async () => unwrap(await ctx.api('PATCH', '/api/cycleplans/board/open', a.cycle_id ? { cycleId: a.cycle_id, open: a.open } : { period: a.deadline_date, open: a.open })) };
  },
}));

module.exports = { opsTools };
