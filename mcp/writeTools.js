// ─────────────────────────────────────────────────────────────────────
//  Skill Lab MCP tools — ROUND 2: WRITE (with preview → confirm)
//
//  Every tool here works in two steps (see confirm.js):
//    1. called without confirm  → returns a PREVIEW, saves nothing
//    2. called with confirm=true + preview_token → SAVES
//
//  The actual saving is done by the SAME functions the website routes use
//  (saveCycleReport, saveCycleMarks, upsertDailyLog, saveCyclePlan), so
//  permissions and validation are identical to the website.
//
//  No tool here deletes anything.
// ─────────────────────────────────────────────────────────────────────
const { z } = require('zod');

const Batch     = require('../models/Batch');
const files     = require('../services/fileStore');
const Student   = require('../models/Student');
const CycleMark = require('../models/CycleMark');
const CyclePlan = require('../models/CyclePlan');
const DailyLog  = require('../models/DailyLog');
const Plan      = require('../models/Plan');
const User      = require('../models/User');

const { canAccessBatch } = require('../middleware/auth');
const { saveCycleReport }  = require('../routes/cycles').__shared;
const { saveCycleMarks, setAssessmentHeld } = require('../routes/cyclemarks').__shared;
const { upsertDailyLog }   = require('../routes/logs').__shared;
const planStore = require('../services/planStore');
const { saveCyclePlan }    = require('../routes/cycleplans').__shared;
const { ToolError, helpers } = require('./tools');
const { requireId, loadCycleChecked, dayKey, ymd, MARKS_RULES } = helpers;
const { makePreviewToken, checkPreviewToken } = require('./confirm');

// ── shared bits ──────────────────────────────────────────────────────

const CONFIRM_FIELDS = {
  confirm: z.boolean().optional().describe('Leave out (or false) to get a PREVIEW. Set true ONLY after the user explicitly approved that preview.'),
  preview_token: z.string().optional().describe('The preview_token returned by the preview call. Required when confirm=true.'),
};

const HOW_TO_CONFIRM =
  ' TWO STEPS: (1) call without confirm — nothing is saved, you get a preview and a preview_token; ' +
  '(2) show the preview to the user in plain words and ask for a clear yes. Only after they say yes, call again with the ' +
  'SAME arguments plus confirm=true and the preview_token. Never confirm on your own.';

// India time, for "is this date in the future?" checks (the college is in IST).
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// Turn a route's { status, body } into a result or a readable error.
function unwrap(r) {
  if (r.status >= 400) {
    const extra = Array.isArray(r.body?.errors) && r.body.errors.length ? ' ' + r.body.errors.join('; ') : '';
    throw new ToolError((r.body?.message || 'Save failed') + extra);
  }
  return r.body;
}

// Must be allowed to WRITE (assigned trainer or superadmin) — same as website.
async function assertCanWrite(user, batchId) {
  if (!(await canAccessBatch(user, batchId)))
    throw new ToolError('You are not assigned to that batch, so you cannot change it.');
}

// Resolve a list of {roll | student_id} to students of ONE batch.
async function resolveStudents(batchId, refs) {
  const roster = await Student.find({ batch: batchId }).select('name roll');
  const byId = new Map(roster.map(s => [s._id.toString(), s]));
  const byRoll = new Map();
  for (const s of roster) {
    const k = String(s.roll || '').trim().toLowerCase();
    if (!k) continue;
    byRoll.set(k, byRoll.has(k) ? 'AMBIGUOUS' : s);
  }
  const found = [], problems = [];
  for (const ref of refs) {
    if (ref.student_id) {
      const s = byId.get(String(ref.student_id));
      s ? found.push(s) : problems.push(`student id ${ref.student_id} is not in this batch`);
    } else if (ref.roll) {
      const s = byRoll.get(String(ref.roll).trim().toLowerCase());
      if (s === 'AMBIGUOUS') problems.push(`roll ${ref.roll} appears twice in this batch — use student_id`);
      else if (!s) problems.push(`roll ${ref.roll} is not in this batch`);
      else found.push(s);
    } else problems.push('each entry needs a roll or student_id');
  }
  return { found, problems, roster };
}

const studentRef = {
  roll: z.string().optional().describe('Roll number'),
  student_id: z.string().optional().describe('Student id (use if a roll is ambiguous)'),
};

// Generic two-step runner. `plan` validates and returns
// { summary, changes, warnings?, apply: async () => result }.
function writeTool(def) {
  return {
    ...def,
    write: true,
    description: def.description + HOW_TO_CONFIRM,
    input: { ...def.input, ...CONFIRM_FIELDS },
    async handler(args, user, ctx) {
      const plan = await def.plan(args, user, ctx);
      if (!args.confirm) {
        return {
          mode: 'preview',
          saved: false,
          summary: plan.summary,
          changes: plan.changes,
          ...(plan.warnings?.length ? { warnings: plan.warnings } : {}),
          preview_token: makePreviewToken(user._id, def.name, args),
          next_step: 'Show this preview to the user and ask for approval. If they approve, call this tool again with the same arguments plus confirm=true and this preview_token.',
        };
      }
      const problem = checkPreviewToken(user._id, def.name, args, args.preview_token);
      if (problem) throw new ToolError(problem);
      const result = await plan.apply();
      return { ...result, mode: 'saved', saved: true, summary: plan.summary };
    },
  };
}

const writeTools = [];

// ── 1. fill_cycle_report (the cycle form) ────────────────────────────

const REPORT_FIELDS = {
  syllabus_coverage:   ['syllabusCoverage',   'Syllabus coverage'],
  coverage_note:       ['coverageNote',       'Coverage note'],
  submitted_count:     ['submittedCount',     'Projects submitted'],
  total_students:      ['totalStudents',      'Total students'],
  performance_rating:  ['performanceRating',  'Batch performance (1–5)'],
  trainer_confidence:  ['trainerConfidence',  'Trainer confidence (1–5)'],
  problems_faced:      ['problemsFaced',      'Problems faced'],
  improvement_needed:  ['improvementNeeded',  'Improvement needed'],
  standout_students:   ['standoutStudents',   'Standout students'],
  struggling_students: ['strugglingStudents', 'Struggling students'],
  topics_not_covered:  ['topicsNotCovered',   'Topics not covered'],
  reflection:          ['reflection',         'Reflection'],
  project_title:       ['projectTitle',       'Project title'],
  project_note:        ['projectNote',        'Project note'],
  avg_attendance:      ['avgAttendance',      'Average attendance %'],
  sessions_held:       ['sessionsHeld',       'Sessions held'],
  topics_planned:      ['topicsPlanned',      'Topics planned'],
  topics_completed:    ['topicsCompleted',    'Topics completed'],
};
const text = (max = 3000) => z.string().max(max).optional();
const count = () => z.number().int().min(0).max(100000).optional();

function reportStatusProblem(cycle, user) {
  if (cycle.status === 'closed') return 'This cycle is closed. Ask the admin to reopen it on the website.';
  if (cycle.status !== 'report-open' && user.role !== 'superadmin')
    return 'The report for this cycle is not open yet. The admin opens it from the Cycles page.';
  return null;
}

writeTools.push(writeTool({
  name: 'fill_cycle_report',
  title: 'Fill the cycle report (cycle form)',
  description:
    'Fill or update fields of a cycle\'s report form — syllabus coverage, ratings, problems faced, standout/struggling students, ' +
    'project title, reflection, and the numbers (attendance, sessions, topics). Only the fields you pass are changed; ' +
    'others stay as they are. Same rules as the website: only the batch\'s trainers or superadmin, only while the report ' +
    'is open (superadmin also before it opens), never once closed. Saving marks the report as submitted, like the website.',
  input: {
    cycle_id: z.string(),
    syllabus_coverage: z.enum(['on-track', 'behind', 'ahead']).optional(),
    coverage_note: text(), submitted_count: count(), total_students: count(),
    performance_rating: z.number().int().min(1).max(5).optional(),
    trainer_confidence: z.number().int().min(1).max(5).optional(),
    problems_faced: text(), improvement_needed: text(), standout_students: text(),
    struggling_students: text(), topics_not_covered: text(), reflection: text(),
    project_title: text(300), project_note: text(),
    avg_attendance: z.number().min(0).max(100).optional(),
    sessions_held: count(), topics_planned: count(), topics_completed: count(),
  },
  async plan(args, user) {
    const cycle = await loadCycleChecked(user, args.cycle_id);
    await assertCanWrite(user, cycle.batch._id);
    const p = reportStatusProblem(cycle, user);
    if (p) throw new ToolError(p);

    const body = {}, changes = [];
    for (const [arg, [field, label]] of Object.entries(REPORT_FIELDS)) {
      if (args[arg] === undefined) continue;
      body[field] = args[arg];
      const before = cycle.report?.[field];
      changes.push({ field: label, from: before === undefined || before === '' ? null : before, to: args[arg] });
    }
    if (!changes.length) throw new ToolError('Pass at least one report field to fill.');
    return {
      summary: `Cycle ${cycle.number} report — ${cycle.batch.name}: ${changes.length} field(s)`,
      changes,
      warnings: cycle.report?.submitted ? [`This report was already submitted on ${ymd(cycle.report.submittedAt)}; these fields will be overwritten.`] : [],
      apply: async () => {
        const out = unwrap(await saveCycleReport(user, cycle._id, body));
        return { reportSubmitted: !!out.cycle?.report?.submitted };
      },
    };
  },
}));

// ── 2. update_cycle_marks ────────────────────────────────────────────

writeTools.push(writeTool({
  name: 'update_cycle_marks',
  title: 'Update cycle marks',
  description:
    'Enter or change marks for specific students in one cycle (only the students you list are touched). ' +
    'For each: state "evaluated" with project (0–100) and — only if the cycle\'s assessment was held — assessment (0–100); ' +
    'or state "not-evaluated" (absent on ' +
    'evaluation day / joined late — no marks). Give 0 and 0 for a student who was evaluated and scored nothing. ' +
    'Category is calculated automatically unless you pass category_override. If a student had a manual category ' +
    'override and you don\'t pass one, it goes back to the automatic category (the preview shows this). ' + MARKS_RULES,
  input: {
    cycle_id: z.string(),
    rows: z.array(z.object({
      ...studentRef,
      state: z.enum(['evaluated', 'not-evaluated']),
      assessment: z.number().min(0).max(100).optional(),
      project: z.number().min(0).max(100).optional(),
      category_override: z.enum(['excellent', 'moderate', 'basic', 'zero']).optional(),
      remark: z.string().max(500).optional(),
    })).min(1).max(300),
  },
  async plan(args, user) {
    const cycle = await loadCycleChecked(user, args.cycle_id);
    await assertCanWrite(user, cycle.batch._id);
    const held = cycle.assessmentHeld !== false;

    const { found, problems } = await resolveStudents(cycle.batch._id, args.rows);
    args.rows.forEach((r, i) => {
      const who = r.roll || r.student_id || `row ${i + 1}`;
      if (r.state === 'evaluated' && r.project === undefined)
        problems.push(`${who}: evaluated needs a project mark (use 0 if they scored nothing)`);
      if (r.state === 'evaluated' && held && r.assessment === undefined)
        problems.push(`${who}: this cycle has an assessment, so give the assessment mark too (or set assessment_held=false with update_cycle if no assessment was taken)`);
      if (r.state === 'evaluated' && !held && r.assessment !== undefined)
        problems.push(`${who}: no assessment was held this cycle — leave assessment out`);
      if (r.state === 'not-evaluated' && (r.assessment !== undefined || r.project !== undefined || r.category_override))
        problems.push(`${who}: not-evaluated cannot have marks or a category`);
    });
    const ids = found.map(s => s._id.toString());
    if (new Set(ids).size !== ids.length) problems.push('the same student is listed more than once');
    if (problems.length) throw new ToolError('Nothing to preview — fix these first: ' + problems.join('; '));

    const existing = await CycleMark.find({ cycle: cycle._id, student: { $in: found.map(s => s._id) } });
    const ex = Object.fromEntries(existing.map(m => [m.student.toString(), m]));

    const rows = [], changes = [];
    args.rows.forEach((r, i) => {
      const s = found[i];
      const old = ex[s._id.toString()];
      const evaluated = r.state === 'evaluated';
      const category = !evaluated ? '' : (r.category_override || CycleMark.categoryFromMarks(r.assessment, r.project, held));
      const score = (a, p) => CycleMark.scoreOf(a, p, held).total;
      const remark = r.remark !== undefined ? r.remark : (old?.remark || '');
      rows.push({
        student: s._id, name: s.name, roll: s.roll,
        status: r.state, assessment: evaluated && held ? r.assessment : null, project: evaluated ? r.project : null,
        category, categoryOverridden: !!r.category_override, remark,
      });
      const oldEval = old && old.status === 'evaluated';
      changes.push({
        roll: s.roll, name: s.name,
        from: oldEval ? { assessment: old.assessment, project: old.project, total: score(old.assessment, old.project), outOf: held ? 200 : 100, category: old.category }
                      : (old ? 'not-evaluated' : 'no entry yet'),
        to: evaluated ? { ...(held ? { assessment: r.assessment } : {}), project: r.project, total: score(r.assessment, r.project), outOf: held ? 200 : 100, category } : 'not-evaluated',
        ...(old?.categoryOverridden && !r.category_override && evaluated ? { note: 'manual category override removed' } : {}),
        ...(r.remark !== undefined ? { remark } : {}),
      });
    });
    return {
      summary: `Cycle ${cycle.number} marks — ${cycle.batch.name}: ${rows.length} student(s)${held ? '' : ' (no assessment this cycle: score = project /100)'}`,
      changes,
      warnings: cycle.status === 'closed' ? ['This cycle is closed; marks can still be changed (same as the website), but its frozen report will not update.'] : [],
      apply: async () => ({ studentsSaved: unwrap(await saveCycleMarks(user, cycle._id, rows)).saved }),
    };
  },
}));

// ── 2b. set_assessment_held ──────────────────────────────────────────

writeTools.push(writeTool({
  name: 'set_assessment_held',
  title: 'Was the assessment held this cycle?',
  description:
    'The MCQ assessment is optional per cycle. Set held=false when no assessment was taken in a cycle: scores then become ' +
    'the project mark out of 100 and every automatic category in the cycle is recalculated (manual overrides stay). ' +
    'held=true goes back to project + assessment out of 200. Batch trainers and superadmin.',
  input: { cycle_id: z.string(), held: z.boolean() },
  async plan(args, user) {
    const cycle = await loadCycleChecked(user, args.cycle_id);
    await assertCanWrite(user, cycle.batch._id);
    const cur = cycle.assessmentHeld !== false;
    if (cur === args.held) throw new ToolError(`Cycle ${cycle.number} is already set to assessment ${cur ? 'held' : 'not held'}.`);
    const affected = await CycleMark.find({ cycle: cycle._id, status: 'evaluated', categoryOverridden: { $ne: true } });
    const changed = affected.map(m => ({ m, to: CycleMark.categoryFromMarks(m.assessment, m.project, args.held) }))
      .filter(x => x.to !== x.m.category);
    const warnings = [];
    if (!args.held && affected.some(m => m.assessment != null))
      warnings.push('Some students already have an assessment mark in this cycle; it will be ignored in their score while the assessment is set to not held.');
    return {
      summary: `Cycle ${cycle.number} — ${cycle.batch.name}: assessment ${args.held ? 'HELD (score /200)' : 'NOT held (score = project /100)'}`,
      changes: { assessmentHeld: { from: cur, to: args.held }, categoriesThatChange: changed.length },
      warnings,
      apply: async () => unwrap(await setAssessmentHeld(user, cycle._id, args.held)),
    };
  },
}));

// ── 3. set_cycle_top3 ────────────────────────────────────────────────

writeTools.push(writeTool({
  name: 'set_cycle_top3',
  title: 'Set cycle Top 3',
  description:
    'Set the Top 3 of a cycle (what the public Hall of Fame shows): rank 1–3, student by roll or id, optional GitHub link. ' +
    'Photos already uploaded for the same student are kept; new photos must be uploaded on the website. ' +
    'Normally NOT needed: the Top 3 fills itself from the marks once every student has a mark (update_cycle_marks). ' +
    'Use this only to override it by hand — after that, new marks no longer change it. ' +
    'Same rules as the cycle report form (it is part of it): opens on the project day, never once closed.',
  input: {
    cycle_id: z.string(),
    top3: z.array(z.object({
      rank: z.number().int().min(1).max(3),
      ...studentRef,
      github: z.string().max(300).optional(),
    })).min(1).max(3),
  },
  async plan(args, user) {
    const cycle = await loadCycleChecked(user, args.cycle_id);
    await assertCanWrite(user, cycle.batch._id);
    const p = reportStatusProblem(cycle, user);
    if (p) throw new ToolError(p);

    const { found, problems } = await resolveStudents(cycle.batch._id, args.top3);
    const ranks = args.top3.map(t => t.rank);
    if (new Set(ranks).size !== ranks.length) problems.push('each rank can be used only once');
    const ids = found.map(s => s._id.toString());
    if (new Set(ids).size !== ids.length) problems.push('the same student is listed twice');
    if (problems.length) throw new ToolError('Nothing to preview — fix these first: ' + problems.join('; '));

    const oldTop = cycle.report?.top3 || [];
    const oldBy = Object.fromEntries(oldTop.filter(t => t.student).map(t => [t.student.toString(), t]));
    const marks = await CycleMark.find({ cycle: cycle._id, student: { $in: found.map(s => s._id) } });
    const markBy = Object.fromEntries(marks.map(m => [m.student.toString(), m]));

    const warnings = [];
    const top3 = args.top3.map((t, i) => {
      const s = found[i];
      const prev = oldBy[s._id.toString()];
      const m = markBy[s._id.toString()];
      if (!m || m.status !== 'evaluated') warnings.push(`${s.name} (${s.roll}) has no evaluated marks in this cycle`);
      return {
        rank: t.rank, student: s._id, name: s.name, roll: s.roll,
        github: t.github !== undefined ? t.github : (prev?.github || ''),
        photo: files.has(prev?.photo) ? { data: prev.photo.data || null, contentType: prev.photo.contentType, key: prev.photo.key || null } : null,
      };
    }).sort((a, b) => a.rank - b.rank);

    return {
      summary: `Cycle ${cycle.number} Top 3 — ${cycle.batch.name}`,
      changes: {
        from: oldTop.slice().sort((a, b) => a.rank - b.rank).map(t => ({ rank: t.rank, name: t.name, roll: t.roll, github: t.github || null })),
        to: top3.map(t => ({ rank: t.rank, name: t.name, roll: t.roll, github: t.github || null, photo: t.photo ? 'kept' : 'none — upload on website' })),
      },
      warnings: [...warnings, 'Saving this also marks the cycle report as submitted (same as saving the form on the website).'],
      apply: async () => {
        unwrap(await saveCycleReport(user, cycle._id, { top3 }));
        return { top3: top3.map(t => ({ rank: t.rank, name: t.name, roll: t.roll })) };
      },
    };
  },
}));

// ── 4. save_daily_log ────────────────────────────────────────────────

writeTools.push(writeTool({
  name: 'save_daily_log',
  title: 'Save a daily class log',
  description:
    'Create or update one batch\'s log for one day: what was taught (notes), status, syllabus topics covered (by title), ' +
    'trainer prep link, and roll-wise attendance. Attendance is given as a list of rolls: mode "absent" = everyone in the ' +
    'batch is present EXCEPT these rolls; mode "present" = ONLY these rolls are present. If a log already exists for that ' +
    'day it is merged (fields you don\'t pass are kept; another trainer\'s attendance entries are not wiped). ' +
    'Future dates are refused. Use today\'s date in India time unless the user says otherwise.',
  input: {
    batch_id: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
    notes: z.string().max(3000).optional().describe('What was taught, in words'),
    status: z.enum(['done', 'partial', 'not-covered', 'no-class']).optional()
      .describe('done = as planned, partial, not-covered. no-class = no class that day (holiday/cancelled) — admin only'),
    plan_class: z.number().int().min(1).max(200).optional()
      .describe('Class number from the cycle plan that was taught. If left out, the class planned for that date is used.'),
    github: z.enum(['all', 'most', 'few', 'none', 'na']).optional()
      .describe('Did students push today\'s code to GitHub? all / most / few / none / na (not needed today)'),
    topics_covered: z.array(z.string()).max(30).optional().describe('Topic titles from the batch syllabus plan'),
    prep_link: z.string().max(500).optional(),
    attendance: z.object({
      mode: z.enum(['absent', 'present']).describe('"absent": listed rolls are absent, rest present. "present": only listed rolls present.'),
      rolls: z.array(z.string()).max(400),
    }).optional(),
  },
  async plan(args, user) {
    requireId(args.batch_id, 'batch');
    const batch = await Batch.findById(args.batch_id).select('name');
    if (!batch) throw new ToolError('Batch not found.');
    await assertCanWrite(user, batch._id);
    if (args.date > todayIST()) throw new ToolError(`${args.date} is in the future. Logs can only be saved for today or earlier.`);
    if (isNaN(new Date(args.date))) throw new ToolError('Invalid date.');

    const existing = await DailyLog.findOne({ batch: batch._id, date: dayKey(args.date) });
    const problems = [], warnings = [];

    // Topics: match titles from the batch plan
    let topicIds = existing ? existing.topicsCovered : [];
    let topicTitles = [];
    if (args.topics_covered) {
      const plan = await Plan.findOne({ batch: batch._id });
      const topics = plan?.topics || [];
      topicIds = [];
      for (const want of args.topics_covered) {
        const w = want.trim().toLowerCase();
        const exact = topics.filter(t => t.title.toLowerCase() === w);
        const partial = exact.length ? exact : topics.filter(t => t.title.toLowerCase().includes(w));
        if (partial.length === 1) { topicIds.push(partial[0]._id); topicTitles.push(partial[0].title); }
        else problems.push(partial.length ? `topic "${want}" matches several plan topics — be more specific`
          : `topic "${want}" is not in this batch's plan${topics.length ? ` (plan has: ${topics.slice(0, 25).map(t => t.title).join(', ')})` : ' (the plan has no topics yet — put it in notes instead)'}`);
      }
    }

    // Attendance
    let attendance = [], presentCount = null, absentees = [];
    if (args.attendance) {
      const { found, problems: p, roster } = await resolveStudents(batch._id, args.attendance.rolls.map(roll => ({ roll })));
      problems.push(...p);
      if (!roster.length) problems.push('this batch has no students yet');
      const listed = new Set(found.map(s => s._id.toString()));
      const presentIf = (s) => args.attendance.mode === 'absent' ? !listed.has(s._id.toString()) : listed.has(s._id.toString());
      attendance = roster.map(s => ({ student: s._id, present: presentIf(s) }));
      presentCount = attendance.filter(a => a.present).length;
      absentees = roster.filter(s => !presentIf(s)).map(s => `${s.roll} ${s.name}`);
    } else if (!existing?.attendanceTaken) {
      warnings.push('No attendance given — this day will NOT count as a session for attendance %.');
    }
    if (problems.length) throw new ToolError('Nothing to preview — fix these first: ' + problems.join('; '));

    const body = {
      batch: batch._id, date: args.date,
      notes:    args.notes     !== undefined ? args.notes     : (existing?.notes || ''),
      status:   args.status    !== undefined ? args.status    : (existing?.status || 'done'),
      prepLink: args.prep_link !== undefined ? args.prep_link : (existing?.prepLink || ''),
      topicsCovered: topicIds,
      attendance,
      ...(args.plan_class !== undefined ? { planClass: args.plan_class } : {}),
      ...(args.github !== undefined ? { github: args.github } : {}),
    };
    if (body.status === 'no-class' && user.role !== 'superadmin')
      throw new ToolError('Only the admin can mark a day as "no class".');
    if (existing) warnings.push(`A log already exists for ${args.date}; it will be updated (fields you didn't give are kept).`);

    return {
      summary: `${existing ? 'Update' : 'New'} daily log — ${batch.name}, ${args.date}`,
      changes: {
        notes: body.notes || null,
        status: body.status,
        ...(args.plan_class !== undefined ? { planClass: args.plan_class } : {}),
        ...(args.github !== undefined ? { github: args.github } : {}),
        ...(args.topics_covered ? { topicsCovered: topicTitles } : {}),
        ...(args.prep_link !== undefined ? { prepLink: body.prepLink } : {}),
        ...(args.attendance ? {
          attendance: { present: presentCount, absent: absentees.length, total: attendance.length,
                        absentees: absentees.slice(0, 80), ...(absentees.length > 80 ? { more: absentees.length - 80 } : {}) },
        } : {}),
      },
      warnings,
      apply: async () => {
        const out = unwrap(await upsertDailyLog(user, body));
        const l = out.log;
        return { date: ymd(l.date), present: l.attendance.filter(a => a.present).length, recorded: l.attendance.length };
      },
    };
  },
}));

// ── 5. save_cycle_plan_class ─────────────────────────────────────────

writeTools.push(writeTool({
  name: 'save_cycle_plan_class',
  title: 'Add or edit a class in the cycle plan',
  description:
    'Add a new class to a cycle\'s class-by-class plan, or edit an existing one by class_number. Only the fields you pass ' +
    'are changed. Trainer is matched by name among the batch\'s assigned trainers. A new class needs a title; if ' +
    'class_number is left out it becomes the next number. Once a plan has classes, trainers can change it only while the ' +
    'admin has opened editing for that cycle.',
  input: {
    cycle_id: z.string(),
    class_number: z.number().int().min(1).max(200).optional(),
    title: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    time: z.string().max(20).optional().describe('e.g. 10:00'),
    trainer: z.string().optional().describe('Trainer name (must be assigned to this batch). Empty string clears it.'),
  },
  async plan(args, user) {
    const cycle = await loadCycleChecked(user, args.cycle_id);
    await assertCanWrite(user, cycle.batch._id);

    const plan = await CyclePlan.findOne({ cycle: cycle._id });
    const right = await planStore.editRight(user, cycle, plan?.classes || []);
    if (!right.ok) throw new ToolError(right.message);
    const classes = (plan?.classes || []).map(c => ({
      number: c.number, title: c.title, notes: c.notes, trainer: c.trainer || null, date: c.date, time: c.time,
    }));
    const trainers = await User.find({ _id: { $in: cycle.batch.trainers } }).select('name');
    const nameOf = (id) => id ? (trainers.find(t => t._id.toString() === String(id))?.name || 'unknown') : null;

    let trainerId;
    if (args.trainer !== undefined) {
      if (args.trainer === '') trainerId = null;
      else {
        const w = args.trainer.trim().toLowerCase();
        const m = trainers.filter(t => t.name.toLowerCase().includes(w));
        if (m.length !== 1) throw new ToolError(m.length
          ? `"${args.trainer}" matches several trainers: ${m.map(t => t.name).join(', ')}`
          : `"${args.trainer}" is not a trainer of this batch. Assigned: ${trainers.map(t => t.name).join(', ') || 'none'}`);
        trainerId = m[0]._id;
      }
    }

    let target = args.class_number ? classes.find(c => c.number === args.class_number) : null;
    const isNew = !target;
    const before = target ? { ...target, trainer: nameOf(target.trainer) } : null;
    if (isNew) {
      if (!args.title) throw new ToolError('A new class needs a title.');
      const next = classes.reduce((m, c) => Math.max(m, c.number), 0) + 1;
      target = { number: args.class_number || next, title: '', notes: '', trainer: null, date: '', time: '' };
      classes.push(target);
    }
    if (args.title !== undefined) target.title = args.title;
    if (args.notes !== undefined) target.notes = args.notes;
    if (args.date  !== undefined) target.date  = args.date;
    if (args.time  !== undefined) target.time  = args.time;
    if (trainerId  !== undefined) target.trainer = trainerId;
    classes.sort((a, b) => a.number - b.number);

    const warnings = [];
    if (target.date && (target.date < ymd(cycle.startDate) || target.date > ymd(cycle.endDate)))
      warnings.push(`${target.date} is outside this cycle (${ymd(cycle.startDate)} to ${ymd(cycle.endDate)}).`);

    return {
      summary: `${isNew ? 'Add' : 'Edit'} class ${target.number} — Cycle ${cycle.number}, ${cycle.batch.name}`,
      changes: { from: before, to: { ...target, trainer: nameOf(target.trainer) } },
      warnings,
      apply: async () => {
        unwrap(await saveCyclePlan(user, cycle._id, classes));
        return { classNumber: target.number, totalClasses: classes.length };
      },
    };
  },
}));

module.exports = { writeTools, writeTool, unwrap, resolveStudents, studentRef, todayIST };
