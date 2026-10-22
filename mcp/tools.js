// ─────────────────────────────────────────────────────────────────────
//  Skill Lab MCP tools — ROUND 1: READ-ONLY
//
//  A "tool" is a function an AI app is allowed to call. Each one has:
//    • a name            (what the AI calls)
//    • a description     (how the AI decides WHEN to call it — write it well!)
//    • an input schema   (which arguments it accepts, checked with zod)
//    • a handler         (our code: query MongoDB, return compact JSON)
//
//  Every handler receives `user` — the Skill Lab user who owns the token.
//  Superadmin sees everything; trainers / co-trainers see ONLY the batches
//  they are assigned to (stricter than the website, where trainers can
//  browse other batches read-only).
//
//  Nothing in this file writes to the database except the audit log.
// ─────────────────────────────────────────────────────────────────────
const mongoose  = require('mongoose');
const { z }     = require('zod');

const Semester = require('../models/Semester');
const Batch     = require('../models/Batch');
const Student   = require('../models/Student');
const Cycle     = require('../models/Cycle');
const CycleMark = require('../models/CycleMark');
const CyclePlan = require('../models/CyclePlan');
const DailyLog  = require('../models/DailyLog');
const Plan      = require('../models/Plan');
const Topper    = require('../models/Topper');
const { readableBatchIds } = require('../middleware/auth');
const { studentAttendance } = require('../routes/cyclemarks').__shared;
const { countsForAttendance } = require('../routes/logs').__test;

// ── Small helpers ────────────────────────────────────────────────────

// A friendly error the AI will read and relay. (Thrown → returned as isError.)
class ToolError extends Error {}

const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(new mongoose.Types.ObjectId(v)) === String(v);
function requireId(v, what) {
  if (!isId(v)) throw new ToolError(`"${v}" is not a valid ${what} id. Use list_batches / list_cycles / search to find ids.`);
}

// Same day-boundary rule the routes use (server-local midnight).
function dayKey(d) { const dt = new Date(d); dt.setHours(0, 0, 0, 0); return dt; }
// Dates are stored at server-local midnight (dayKey), so format them with the
// server's local calendar too — toISOString() would show the previous day on a
// server running ahead of UTC (e.g. in IST).
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => {
  if (!d) return null;
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
};

// Returns null (= all batches) for superadmin, else the list of allowed ids.
async function scope(user) { return readableBatchIds(user); }

async function assertBatchAccess(user, batchId) {
  const allowed = await scope(user);
  if (allowed === null) return;
  if (!allowed.some(id => id.toString() === batchId.toString()))
    throw new ToolError('You are not assigned to that batch, so you cannot view it.');
}

async function loadCycleChecked(user, cycleId) {
  requireId(cycleId, 'cycle');
  const cycle = await Cycle.findById(cycleId).populate('batch', 'name track trainers rosterLocked');
  if (!cycle || !cycle.batch) throw new ToolError('Cycle not found.');
  await assertBatchAccess(user, cycle.batch._id);
  return cycle;
}

const attendancePct = (s) =>
  s.stats?.totalSessions ? Math.round((s.stats.presentCount / s.stats.totalSessions) * 100) : null;

// Shared explanation, pasted into descriptions so the AI reads marks correctly.
const MARKS_RULES =
  'Marks rules: each student per cycle has project /100 and, ONLY in cycles where the assessment was held, an MCQ assessment /100. ' +
  'The assessment is optional: when a cycle has assessmentHeld=false the score is the project mark out of 100; ' +
  'otherwise project + assessment out of 200 (see outOf). ' +
  'state "evaluated" = has marks; state "zero" = evaluated but total is 0; ' +
  'state "not-evaluated" = absent on evaluation day or joined late — NO marks, NO category, ' +
  'and must NOT be counted as 0 or included in averages. ' +
  'Category from score %: excellent ≥75, moderate 50–74, basic 1–49, zero = 0; ' +
  'a trainer may override the category (categoryOverridden=true).';

// ── Tool definitions ─────────────────────────────────────────────────
// Each entry: { name, title, description, input (zod shape), handler(args, user) }

const tools = [];
const def = (t) => tools.push(t);

// 1 ─ whoami
def({
  name: 'whoami',
  title: 'Who am I',
  description:
    'Returns the Skill Lab user this connection acts as (name, role) and the active semester and batches they can see. ' +
    'Call this first if you are unsure what data is available.',
  input: {},
  async handler(_args, user) {
    const active = await Semester.findOne({ status: 'active' });
    const allowed = await scope(user);
    const filter = allowed === null ? {} : { _id: { $in: allowed } };
    if (active) filter.semester = active._id;
    const batches = await Batch.find(filter).select('name track').sort('name');
    return {
      user: { name: user.name, email: user.email, role: user.role },
      access: allowed === null ? 'all batches (superadmin)' : 'only batches you are assigned to',
      activeSemester: active ? { id: active._id, name: active.name } : null,
      batches: batches.map(b => ({ id: b._id, name: b.name, track: b.track })),
    };
  },
});

// 2 ─ search
def({
  name: 'search',
  title: 'Search students, batches, cycles',
  description:
    'Search Skill Lab by text. Matches student name or roll number, batch name or track (e.g. "MERN"), ' +
    'and cycle name or number ("cycle 3" or "3"). Use it to turn a name the user mentions into an id for other tools.',
  input: { query: z.string().min(2).describe('Text to search, at least 2 characters') },
  async handler({ query }, user) {
    const q  = query.trim();
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const numMatch = q.match(/(?:^|\s|cycle)\s*(\d{1,3})\s*$/i);
    const cycleNumber = numMatch ? parseInt(numMatch[1], 10) : null;

    const allowed = await scope(user);
    const batchFilter = allowed === null ? {} : { _id: { $in: allowed } };
    const inScope     = allowed === null ? {} : { batch: { $in: allowed } };

    const [students, batches, cycles] = await Promise.all([
      Student.find({ ...inScope, $or: [{ name: rx }, { roll: rx }] })
        .select('name roll course sem section batch').populate('batch', 'name').limit(20),
      Batch.find({ ...batchFilter, $or: [{ name: rx }, { track: rx }] }).select('name track').limit(10),
      Cycle.find({ ...inScope, $or: [{ name: rx }, ...(cycleNumber !== null ? [{ number: cycleNumber }] : [])] })
        .select('number name status batch startDate endDate').populate('batch', 'name').limit(10),
    ]);
    return {
      students: students.map(s => ({ id: s._id, name: s.name, roll: s.roll, course: s.course, sem: s.sem, section: s.section, batch: s.batch?.name, batchId: s.batch?._id })),
      batches:  batches.map(b => ({ id: b._id, name: b.name, track: b.track })),
      cycles:   cycles.map(c => ({ id: c._id, number: c.number, name: c.name, status: c.status, batch: c.batch?.name, start: ymd(c.startDate), end: ymd(c.endDate) })),
    };
  },
});

// 3 ─ list_batches
def({
  name: 'list_batches',
  title: 'List batches',
  description:
    'Lists training batches (a batch = one training group, e.g. "BTech 3rd Sem Combined" or the MERN track) with track, trainers, ' +
    'student count and whether the roster is locked. Defaults to the active semester.',
  input: { include_archived: z.boolean().optional().describe('Also include batches from archived semesters (default false)') },
  async handler({ include_archived }, user) {
    const allowed = await scope(user);
    const filter = allowed === null ? {} : { _id: { $in: allowed } };
    if (!include_archived) {
      const active = await Semester.findOne({ status: 'active' });
      if (active) filter.semester = active._id;
    }
    const batches = await Batch.find(filter).populate('trainers', 'name').populate('semester', 'name status').sort('name');
    const counts = await Student.aggregate([
      { $match: { batch: { $in: batches.map(b => b._id) } } },
      { $group: { _id: '$batch', n: { $sum: 1 } } },
    ]);
    const countBy = Object.fromEntries(counts.map(c => [c._id.toString(), c.n]));
    return {
      batches: batches.map(b => ({
        id: b._id, name: b.name, track: b.track, composition: b.composition,
        semester: b.semester?.name, semesterStatus: b.semester?.status,
        trainers: (b.trainers || []).map(t => t.name),
        students: countBy[b._id.toString()] || 0,
        rosterLocked: !!b.rosterLocked, isActive: b.isActive,
      })),
    };
  },
});

// 4 ─ get_batch_roster
def({
  name: 'get_batch_roster',
  title: 'Batch roster with attendance',
  description:
    'Students in one batch with roll, name, course/section, overall attendance % for the batch, sessions present/held, ' +
    'times in top 3, and the trainer "flagged" mark. Supports text filter and paging. ' +
    'Attendance % here = sessions present ÷ sessions the batch held where attendance was taken.',
  input: {
    batch_id:     z.string().describe('Batch id (from list_batches or search)'),
    search:       z.string().optional().describe('Filter by name or roll'),
    flagged_only: z.boolean().optional(),
    max_attendance_pct: z.number().min(0).max(100).optional().describe('Only students at or below this attendance %, e.g. 50'),
    limit:  z.number().int().min(1).max(300).optional().describe('Default 150'),
    offset: z.number().int().min(0).optional(),
  },
  async handler({ batch_id, search, flagged_only, max_attendance_pct, limit = 150, offset = 0 }, user) {
    requireId(batch_id, 'batch');
    const batch = await Batch.findById(batch_id).select('name track rosterLocked');
    if (!batch) throw new ToolError('Batch not found.');
    await assertBatchAccess(user, batch._id);

    const filter = { batch: batch._id };
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { roll: rx }];
    }
    if (flagged_only) filter.flagged = true;
    let students = await Student.find(filter).select('-photo').sort('roll name');
    let rows = students.map(s => ({
      id: s._id, roll: s.roll, name: s.name, course: s.course, sem: s.sem, section: s.section,
      attendancePct: attendancePct(s),
      sessionsPresent: s.stats?.presentCount || 0, sessionsHeld: s.stats?.totalSessions || 0,
      top3Count: s.stats?.topperCount || 0, flagged: !!s.flagged,
    }));
    if (max_attendance_pct !== undefined)
      rows = rows.filter(r => r.attendancePct !== null && r.attendancePct <= max_attendance_pct);
    return {
      batch: { id: batch._id, name: batch.name, track: batch.track, rosterLocked: !!batch.rosterLocked },
      total: rows.length, offset, returned: Math.min(limit, Math.max(0, rows.length - offset)),
      students: rows.slice(offset, offset + limit),
    };
  },
});

// 5 ─ list_cycles
def({
  name: 'list_cycles',
  title: 'List cycles',
  description:
    'Lists training cycles (2–3 week blocks, each ending in a project + assessment) with number, dates and status ' +
    '(active = teaching, report-open = report being filled, closed = frozen). Optionally for one batch.',
  input: { batch_id: z.string().optional().describe('Only cycles of this batch') },
  async handler({ batch_id }, user) {
    const allowed = await scope(user);
    const filter = allowed === null ? {} : { batch: { $in: allowed } };
    if (batch_id) {
      requireId(batch_id, 'batch');
      await assertBatchAccess(user, batch_id);
      filter.batch = batch_id;
    }
    const cycles = await Cycle.find(filter).select('-report.top3.photo').populate('batch', 'name track').sort('-startDate').limit(200);
    return {
      cycles: cycles.map(c => ({
        id: c._id, number: c.number, name: c.name, status: c.status,
        batch: c.batch?.name, batchId: c.batch?._id, track: c.batch?.track,
        start: ymd(c.startDate), end: ymd(c.endDate),
        reportSubmitted: !!c.report?.submitted,
        assessmentHeld: c.assessmentHeld !== false,
      })),
    };
  },
});

// 6 ─ get_cycle_marks
def({
  name: 'get_cycle_marks',
  title: 'Cycle marks sheet',
  description:
    'The marks sheet of one cycle: every student in the batch with attendance % within the cycle dates, state, assessment, ' +
    'project, total, category and remark — plus a summary (counts per category, average of evaluated students, suggested top 3). ' +
    MARKS_RULES,
  input: {
    cycle_id: z.string().describe('Cycle id (from list_cycles or search)'),
    category: z.enum(['excellent', 'moderate', 'basic', 'zero']).optional().describe('Only students in this category'),
    state:    z.enum(['evaluated', 'zero', 'not-evaluated']).optional().describe('Only students in this state'),
  },
  async handler({ cycle_id, category, state }, user) {
    const cycle = await loadCycleChecked(user, cycle_id);
    const students = await Student.find({ batch: cycle.batch._id }).select('name roll').sort('roll name');
    const marks = await CycleMark.find({ cycle: cycle._id });
    const byStudent = Object.fromEntries(marks.map(m => [m.student.toString(), m]));
    const att = await studentAttendance(cycle.batch._id, cycle.startDate, cycle.endDate);
    const held = cycle.assessmentHeld !== false;
    const outOf = held ? 200 : 100;

    let rows = students.map(s => {
      const m = byStudent[s._id.toString()];
      const evaluated = m && m.status === 'evaluated';
      const total = evaluated ? CycleMark.scoreOf(m.assessment, m.project, held).total : null;
      return {
        studentId: s._id, roll: s.roll, name: s.name,
        attendancePct: att.pctFor(s._id.toString()),
        state: !evaluated ? 'not-evaluated' : total === 0 ? 'zero' : 'evaluated',
        assessment: evaluated && held ? m.assessment : null,
        project:    evaluated ? m.project : null,
        total,
        category: evaluated ? m.category : null,
        categoryOverridden: evaluated ? !!m.categoryOverridden : false,
        remark: m?.remark || '',
      };
    });

    const evaluatedRows = rows.filter(r => r.state !== 'not-evaluated');
    const summary = {
      students: rows.length,
      evaluated: evaluatedRows.length,
      notEvaluated: rows.length - evaluatedRows.length,
      byCategory: ['excellent', 'moderate', 'basic', 'zero'].reduce((o, c) => (o[c] = evaluatedRows.filter(r => r.category === c).length, o), {}),
      assessmentHeld: held,
      outOf,
      averageScore: evaluatedRows.length
        ? Math.round((evaluatedRows.reduce((a, r) => a + r.total, 0) / evaluatedRows.length) * 10) / 10 : null,
      sessionsInCycle: att.sessions,
      suggestedTop3: evaluatedRows.filter(r => r.total > 0).sort((a, b) => b.total - a.total).slice(0, 3)
        .map((r, i) => ({ rank: i + 1, name: r.name, roll: r.roll, total: r.total })),
      attendanceIsProvisional: !cycle.batch.rosterLocked,
    };

    if (category) rows = rows.filter(r => r.category === category);
    if (state)    rows = rows.filter(r => r.state === state);

    return {
      cycle: { id: cycle._id, number: cycle.number, name: cycle.name, status: cycle.status,
               batch: cycle.batch.name, start: ymd(cycle.startDate), end: ymd(cycle.endDate) },
      summary, rows,
    };
  },
});

// 7 ─ get_cycle_plan
def({
  name: 'get_cycle_plan',
  title: 'Cycle class plan',
  description:
    'The class-by-class plan of one cycle: class number, title, notes, trainer, date and time. ' +
    'Also says, for each planned date that has passed, whether a daily log exists for that day.',
  input: { cycle_id: z.string() },
  async handler({ cycle_id }, user) {
    const cycle = await loadCycleChecked(user, cycle_id);
    const plan = await CyclePlan.findOne({ cycle: cycle._id }).populate('classes.trainer', 'name');
    const logs = await DailyLog.find({ batch: cycle.batch._id,
      date: { $gte: dayKey(cycle.startDate), $lte: new Date(dayKey(cycle.endDate).getTime() + 86399999) } }).select('date');
    const loggedDays = new Set(logs.map(l => ymd(dayKey(l.date))));
    const today = ymd(new Date());
    return {
      cycle: { id: cycle._id, number: cycle.number, batch: cycle.batch.name, start: ymd(cycle.startDate), end: ymd(cycle.endDate) },
      classes: (plan?.classes || []).slice().sort((a, b) => a.number - b.number).map(c => ({
        number: c.number, title: c.title, notes: c.notes, trainer: c.trainer?.name || null,
        date: c.date || null, time: c.time || null,
        logged: c.date && c.date <= today ? loggedDays.has(c.date) : null,
      })),
    };
  },
});

// 8 ─ get_daily_logs
def({
  name: 'get_daily_logs',
  title: 'Daily class logs',
  description:
    'Daily logs of one batch, newest first: date, what was taught (notes), syllabus topics covered, status (done/partial/not-covered), ' +
    'trainer prep link, who logged it, and present/absent counts. Set include_absentees=true to list absent students.',
  input: {
    batch_id: z.string(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
    include_absentees: z.boolean().optional(),
  },
  async handler({ batch_id, from, to, limit = 20, include_absentees }, user) {
    requireId(batch_id, 'batch');
    const batch = await Batch.findById(batch_id).select('name');
    if (!batch) throw new ToolError('Batch not found.');
    await assertBatchAccess(user, batch._id);

    const filter = { batch: batch._id };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = dayKey(from);
      if (to)   filter.date.$lte = new Date(dayKey(to).getTime() + 86399999);
    }
    const logs = await DailyLog.find(filter).populate('loggedBy', 'name').sort('-date').limit(limit);
    const plan = await Plan.findOne({ batch: batch._id });
    const topicTitle = (id) => plan?.topics.id(id)?.title || null;

    let studentInfo = {};
    if (include_absentees) {
      const studs = await Student.find({ batch: batch._id }).select('name roll');
      studentInfo = Object.fromEntries(studs.map(s => [s._id.toString(), { name: s.name, roll: s.roll }]));
    }

    return {
      batch: batch.name,
      logs: logs.map(l => {
        const taken = countsForAttendance(l);
        const present = l.attendance.filter(a => a.present).length;
        return {
          date: ymd(l.date), status: l.status, planClass: l.planClass ?? null, github: l.github || null,
          notes: l.notes, prepLink: l.prepLink || null,
          topicsCovered: (l.topicsCovered || []).map(topicTitle).filter(Boolean),
          loggedBy: l.loggedBy?.name || null,
          attendanceTaken: taken,
          present: taken ? present : null,
          absent:  taken ? l.attendance.length - present : null,
          ...(include_absentees && taken ? {
            absentees: l.attendance.filter(a => !a.present).map(a => studentInfo[a.student.toString()] || { id: a.student }),
          } : {}),
        };
      }),
    };
  },
});

// 9 ─ get_student_profile
def({
  name: 'get_student_profile',
  title: 'Student profile',
  description:
    'One student\'s full Skill Lab picture: identity, batch, overall attendance, category history across cycles ' +
    '(baseline = first evaluated cycle, current = latest), top-3 finishes and the trainer flag. ' +
    'Pass student_id, or roll (a roll can match more than one record if the student is in two batches). ' + MARKS_RULES,
  input: {
    student_id: z.string().optional(),
    roll: z.string().optional(),
  },
  async handler({ student_id, roll }, user) {
    if (!student_id && !roll) throw new ToolError('Pass student_id or roll.');
    const allowed = await scope(user);
    const filter = allowed === null ? {} : { batch: { $in: allowed } };
    if (student_id) { requireId(student_id, 'student'); filter._id = student_id; }
    else filter.roll = String(roll).trim();

    const students = await Student.find(filter).select('-photo').populate('batch', 'name track').limit(5);
    if (!students.length) throw new ToolError('No student found (or not in a batch you can see).');

    const profiles = [];
    for (const s of students) {
      const marks = await CycleMark.find({ student: s._id, status: 'evaluated' }).populate('cycle', 'number name startDate assessmentHeld');
      const history = marks.filter(m => m.cycle)
        .sort((a, b) => new Date(a.cycle.startDate) - new Date(b.cycle.startDate))
        .map(m => ({ cycleNumber: m.cycle.number, cycleName: m.cycle.name || null,
                     assessment: m.assessment, project: m.project,
                     ...CycleMark.scoreOf(m.assessment, m.project, m.cycle.assessmentHeld !== false),
                     category: m.category, remark: m.remark || '' }));
      const notEvaluated = await CycleMark.countDocuments({ student: s._id, status: 'not-evaluated' });
      const top3 = await Topper.find({ student: s._id }).select('rank cycle project');
      const reportTop3 = await Cycle.find({ 'report.top3.student': s._id }).select('number report.top3.rank report.top3.student report.top3.github');
      profiles.push({
        id: s._id, name: s.name, roll: s.roll, course: s.course, sem: s.sem, section: s.section,
        batch: s.batch?.name, track: s.batch?.track, flagged: !!s.flagged,
        attendancePct: attendancePct(s),
        sessionsPresent: s.stats?.presentCount || 0, sessionsHeld: s.stats?.totalSessions || 0,
        categoryHistory: history,
        baseline: history[0] || null,
        current: history[history.length - 1] || null,
        cyclesNotEvaluated: notEvaluated,
        top3Finishes: [
          ...reportTop3.map(c => {
            const e = c.report.top3.find(t => String(t.student) === String(s._id));
            return { cycle: `Cycle ${c.number}`, rank: e?.rank, github: e?.github || null };
          }),
          ...top3.map(t => ({ cycle: t.cycle, rank: t.rank, project: t.project || null, legacy: true })),
        ],
      });
    }
    return { matches: profiles.length, students: profiles };
  },
});

// 10 ─ get_today_overview
def({
  name: 'get_today_overview',
  title: 'Today overview',
  description:
    'The "Today" dashboard for the active semester: for each batch, whether today\'s class was logged, the last log date, ' +
    'syllabus plan progress (topics done of total) and the next topic. Good for "who hasn\'t logged today?".',
  input: {},
  async handler(_args, user) {
    const active = await Semester.findOne({ status: 'active' });
    if (!active) return { semester: null, batches: [] };
    const allowed = await scope(user);
    const filter = { semester: active._id, ...(allowed === null ? {} : { _id: { $in: allowed } }) };
    const batches = await Batch.find(filter).populate('trainers', 'name').sort('name');
    const today = dayKey(new Date()).getTime();
    const rows = [];
    for (const b of batches) {
      const last = await DailyLog.findOne({ batch: b._id }).sort('-date').select('date');
      const plan = await Plan.findOne({ batch: b._id });
      const total = plan ? plan.topics.length : 0;
      const done  = plan ? plan.topics.filter(t => t.status === 'done').length : 0;
      rows.push({
        batchId: b._id, batch: b.name, track: b.track, trainers: b.trainers.map(t => t.name),
        loggedToday: !!last && dayKey(last.date).getTime() === today,
        lastLogDate: last ? ymd(last.date) : null,
        planDone: done, planTotal: total, planPct: total ? Math.round((done / total) * 100) : 0,
        nextTopic: !plan ? 'no plan' : total === 0 ? 'no topics planned'
          : (plan.topics.find(t => t.status !== 'done')?.title || 'plan complete'),
      });
    }
    return { semester: active.name, date: ymd(new Date()), batches: rows };
  },
});

// 11 ─ get_hall_of_fame
def({
  name: 'get_hall_of_fame',
  title: 'Hall of Fame',
  description:
    'The public Hall of Fame: for each batch, the latest cycle\'s top 3 students with rank, roll and GitHub link. ' +
    'This is the same data shown publicly on skilllab.sheat.ac.in.',
  input: {},
  async handler() {
    const cycles = await Cycle.find({ 'report.top3.0': { $exists: true } })
      .select('number name startDate endDate batch report.top3.rank report.top3.name report.top3.roll report.top3.github')
      .populate('batch', 'name track').sort('-startDate');
    const seen = new Set();
    const latest = cycles.filter(c => {
      const k = c.batch?._id ? String(c.batch._id) : `x-${c._id}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    return {
      entries: latest.map(c => ({
        batch: c.batch?.name, track: c.batch?.track, cycle: c.number,
        start: ymd(c.startDate), end: ymd(c.endDate),
        top3: (c.report.top3 || []).slice().sort((a, b) => a.rank - b.rank)
          .map(t => ({ rank: t.rank, name: t.name, roll: t.roll, github: t.github || null })),
      })),
    };
  },
});

// 12 ─ get_trainer_performance
def({
  name: 'get_trainer_performance',
  title: 'Trainer performance',
  description:
    'The Trainer Performance dashboard. Cycles are grouped by DEADLINE DATE (period), so batches that finished together show together ' +
    'even if their cycle numbers differ (e.g. 1st-year Cycle 1 and 3rd-sem Cycle 3 both due 17 Oct). Pass deadline_date (YYYY-MM-DD) ' +
    'or cycle_number; default = the latest tracked period. Per batch: project day, ' +
    'deadline (default Saturday after the project day, 7 PM IST), when report/marks/Top 3/plan were first completed and by whom ' +
    '(admin=true means done by an admin, not the trainer — the trainer gets no credit), overall status (on-time / late / admin / ' +
    'missing / pending), daily-log punctuality and a score out of 100; plus each trainer\'s score for that cycle and semester average. ' +
    'Score = daily log same day 35, report 10, marks 10, Top 3 10, cycle plan before start 15, attendance taken 10, outcomes 10, ' +
    'counted only over parts already due. Untracked cycles (before tracking began) have no score. ' +
    'Batches with several trainers: each cycle has a lead and an owner per task (report, marks, top3, plan; default = lead) — only ' +
    'the owner is scored for a task; each class day counts for the trainer planned for it (else who logged it); an admin-approved ' +
    '"waiting on <trainer>" moves lateness to that trainer. perTrainer lists each trainer\'s own score and items.',
  input: {
    cycle_number: z.number().int().min(1).max(100).optional().describe('Cycle number, e.g. 4'),
    deadline_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Deadline day of the period, e.g. 2026-10-17'),
  },
  async handler(args) {
    const Semester = require('../models/Semester');
    const { buildDashboard } = require('../routes/performance').__shared;
    const sem = await Semester.findOne({ status: 'active' });
    if (!sem) throw new ToolError('No active semester.');
    const d = await buildDashboard(sem, { period: args.deadline_date || null, number: args.cycle_number || null });
    return {
      semester: d.semester?.name, period: d.period, cycle: d.number,
      periods: d.periods, trainers: d.trainers,
      batches: d.rows.map(r => ({
        batch: r.batch, cycle: r.number, track: r.track, trainers: r.trainers.map(t => t.name), tracked: r.tracked,
        lead: r.lead?.name, owners: Object.fromEntries(Object.entries(r.owners || {}).map(([k, v]) => [k, v?.name || null])),
        perTrainer: r.perTrainer.map(p => ({ name: p.name, isLead: p.isLead, owns: p.owns, score: p.score })),
        waits: r.waits.filter(w => w.status !== 'rejected'),
        projectDate: r.projectDate, deadline: r.deadline, overall: r.overall, completedAt: r.completedAt,
        lateByDays: r.lateBy, excusedNote: r.excusedNote || undefined, score: r.score, who: r.who,
        dailyLogs: r.items.logs, attendance: r.items.attendance, cyclePlan: r.items.plan.state,
      })),
    };
  },
});

module.exports = {
  tools, ToolError,
  helpers: { requireId, assertBatchAccess, loadCycleChecked, dayKey, ymd, MARKS_RULES },
};
