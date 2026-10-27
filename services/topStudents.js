// ─────────────────────────────────────────────────────────────────────
//  Top students — who is doing well, from the real records:
//    marks       average % over the cycles where the student was evaluated
//    attendance  sessions present ÷ sessions the batch held (roll call taken)
//    projects    projects submitted ÷ projects due (project day passed)
//  Score out of 100 = the college's weights (Settings → Top students) over the
//  parts that exist yet — a part with no data (no cycle marked yet) is left out
//  rather than counted as zero. Labels: Excellent / Good from the cut-offs.
//  A student with no evaluated cycle gets no label yet ("too early").
//  Trainers see their own batches; admin and management see every batch.
// ─────────────────────────────────────────────────────────────────────
const Batch = require('../models/Batch');
const Cycle = require('../models/Cycle');
const CycleMark = require('../models/CycleMark');
const Student = require('../models/Student');
const Semester = require('../models/Semester');
const ProjectSubmission = require('../models/ProjectSubmission');
const Organization = require('../models/Organization');
const tenant = require('./tenant');
const perf = require('./performance');
const { seesAll } = require('../middleware/auth');

const DEFAULTS = { marks: 60, attendance: 25, projects: 15, good: 65, excellent: 80 };
const sid = (x) => String(x?._id || x);
const round1 = (n) => Math.round(n * 10) / 10;

async function weights() {
  const o = await Organization.findById(tenant.currentOrg()).select('settings.studentScore').lean();
  return { ...DEFAULTS, ...(o?.settings?.studentScore || {}) };
}

function scoreOf(parts, w) {
  let sum = 0, wsum = 0;
  for (const k of ['marks', 'attendance', 'projects']) if (parts[k] != null && w[k] > 0) { sum += parts[k] * w[k]; wsum += w[k]; }
  return wsum ? Math.round(sum / wsum) : null;
}

async function topStudents(user, q = {}) {
  const w = await weights();
  const sem = q.semester ? await Semester.findById(q.semester).lean() : await Semester.findOne({ status: 'active' }).lean();
  if (!sem) return { weights: w, semester: null, batches: [], students: [] };
  const bq = { semester: sem._id };
  if (!seesAll(user)) bq.trainers = user._id;
  const batches = await Batch.find(bq).select('name track').sort('name').lean();
  const shown = /^[a-f0-9]{24}$/i.test(q.batch || '') ? batches.filter(b => sid(b) === q.batch) : batches;
  const ids = shown.map(b => b._id);

  const today = perf.istYmd(new Date());
  const [students, cycles] = await Promise.all([
    Student.find({ batch: { $in: ids } }).select('name roll course sem section batch flagged stats photo.contentType').lean(),
    Cycle.find({ batch: { $in: ids } }).select('batch number assessmentHeld endDate track.projectDate report.top3.student').lean(),
  ]);
  const [marks, subs] = await Promise.all([
    CycleMark.find({ cycle: { $in: cycles.map(c => c._id) }, status: 'evaluated' }).select('cycle student assessment project').lean(),
    ProjectSubmission.find({ cycle: { $in: cycles.map(c => c._id) } }).select('cycle student').lean(),
  ]);
  const cycleOf = new Map(cycles.map(c => [sid(c), c]));
  const dueBy = new Map();     // batch → cycles whose project day has passed
  for (const c of cycles) if (perf.dayYmd(perf.projectDayOf(c)) <= today) dueBy.set(sid(c.batch), [...(dueBy.get(sid(c.batch)) || []), sid(c)]);
  const batchName = new Map(shown.map(b => [sid(b), b]));

  const rows = students.map(s => {
    const my = marks.filter(m => sid(m.student) === sid(s));
    const pcts = my.map(m => {
      const c = cycleOf.get(sid(m.cycle));
      const { total, outOf } = CycleMark.scoreOf(m.assessment, m.project, c?.assessmentHeld !== false);
      return 100 * total / outOf;
    });
    const due = dueBy.get(sid(s.batch)) || [];
    const submitted = subs.filter(x => sid(x.student) === sid(s) && due.includes(sid(x.cycle))).length;
    const parts = {
      marks: pcts.length ? round1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
      attendance: s.stats?.totalSessions ? Math.round(100 * (s.stats.presentCount || 0) / s.stats.totalSessions) : null,
      projects: due.length ? Math.round(100 * submitted / due.length) : null,
    };
    const score = scoreOf(parts, w);
    const tier = !pcts.length || score == null ? '' : score >= w.excellent ? 'excellent' : score >= w.good ? 'good' : '';
    const b = batchName.get(sid(s.batch));
    return {
      id: s._id, name: s.name, roll: s.roll, course: s.course, sem: s.sem, section: s.section,
      batch: { id: s.batch, name: b?.name || '', track: b?.track || '' },
      score, tier, ...parts,
      cyclesEvaluated: pcts.length, sessions: s.stats?.totalSessions || 0, present: s.stats?.presentCount || 0,
      projectsSubmitted: submitted, projectsDue: due.length,
      top3: cycles.filter(c => (c.report?.top3 || []).some(t => sid(t.student) === sid(s))).length,
      flagged: !!s.flagged, hasPhoto: !!s.photo?.contentType,
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.top3 - a.top3 || a.name.localeCompare(b.name));

  // rank inside each batch (1 = best of that batch)
  const seen = new Map();
  for (const r of rows) if (r.score != null) { const n = (seen.get(sid(r.batch.id)) || 0) + 1; seen.set(sid(r.batch.id), n); r.batchRank = n; }

  return {
    weights: w, semester: { id: sem._id, name: sem.name },
    batches: batches.map(b => ({ id: b._id, name: b.name, track: b.track || '' })),
    counts: { students: rows.length, excellent: rows.filter(r => r.tier === 'excellent').length, good: rows.filter(r => r.tier === 'good').length },
    students: rows,
  };
}

module.exports = { topStudents, weights, scoreOf, DEFAULTS };
