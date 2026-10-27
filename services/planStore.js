// ─────────────────────────────────────────────────────────────────────
//  The ONLY place that writes a cycle plan. Every path goes through here —
//  website (whole-list save, one-row edits), AI tools, holiday moves and the
//  cycle planner — so the rules below hold everywhere:
//
//  • Access: superadmin, or a trainer of the batch.
//  • Lock: a trainer may edit while the plan is still INCOMPLETE (some class
//    has no topic yet — e.g. the dated empty rows the cycle planner creates)
//    or while the admin has opened editing. A complete plan is locked.
//  • Conflicts: optimistic concurrency. A whole-list save may send the plan
//    `version` it started from; a one-row edit may send that row's
//    `updatedAt`. If someone saved in between → 409 with the current data,
//    never a silent overwrite.
//  • History: every change is described in plan.changes (who, when, what).
//  • Credit: the plan counts as done (track.plan stamp) the first time it
//    becomes COMPLETE — every class has a topic — credited to whoever's save
//    completed it (admin → "made by admin", not counted; see performance.js).
// ─────────────────────────────────────────────────────────────────────
const Batch = require('../models/Batch');
const CyclePlan = require('../models/CyclePlan');
const Cycle     = require('../models/Cycle');
const { canAccessBatch } = require('../middleware/auth');
const perf      = require('./performance');

const LOCKED_MSG = 'This plan is locked. Plans can be changed only while the admin has opened editing (for example in the planning meeting). Ask the admin.';
const isComplete = (classes) => (classes || []).length > 0 && classes.every(c => (c.title || '').trim());
const sid = (x) => x == null ? '' : String(x._id || x);
const FIELDS = ['number', 'title', 'notes', 'trainer', 'date', 'time'];

function normalize(c, i) {
  return {
    number: Number(c.number) || i + 1,
    title:  String(c.title || '').trim().slice(0, 200),
    notes:  String(c.notes || '').trim().slice(0, 2000),
    trainer: c.trainer && /^[a-f0-9]{24}$/i.test(sid(c.trainer)) ? sid(c.trainer) : null,
    date:   /^\d{4}-\d{2}-\d{2}$/.test(c.date || '') ? c.date : '',
    // a clock time "HH:MM" (or a range "HH:MM-HH:MM"), nothing else
    time:   /^\d{1,2}:\d{2}(\s*[-–]\s*\d{1,2}:\d{2})?$/.test(String(c.time || '').trim()) ? String(c.time).trim() : '',
  };
}
const same = (a, b) => FIELDS.every(f => String(a[f] ?? '') === String(b[f] ?? ''));

// Short human description of what changed between two class lists (by class number).
function describeChanges(oldList, newList) {
  const key = (c) => String(c.number);
  const o = new Map(oldList.map(c => [key(c), c])), n = new Map(newList.map(c => [key(c), c]));
  const parts = [];
  const added = [...n.keys()].filter(k => !o.has(k)), removed = [...o.keys()].filter(k => !n.has(k));
  if (added.length) parts.push(`added class ${added.join(', ')}`);
  if (removed.length) parts.push(`removed class ${removed.join(', ')}`);
  for (const [k, c] of n) {
    const p = o.get(k); if (!p) continue;
    const f = [];
    if ((p.date || '') !== (c.date || '')) f.push(`date ${p.date || '—'} → ${c.date || '—'}`);
    if ((p.title || '') !== (c.title || '')) f.push('topic');
    if ((p.notes || '') !== (c.notes || '')) f.push('details');
    if ((p.time || '') !== (c.time || '')) f.push('time');
    if (sid(p.trainer) !== sid(c.trainer)) f.push('trainer');
    if (f.length) parts.push(`class ${k}: ${f.join(', ')}`);
  }
  return parts.join('; ').slice(0, 400);
}

// Can this user edit this cycle's plan right now? → { ok, status, message }
async function editRight(user, cycle, classes) {
  if (!(await canAccessBatch(user, cycle.batch))) return { ok: false, status: 403, message: 'Not your batch' };
  if (user.role === 'superadmin' || cycle.planOpen || !isComplete(classes)) return { ok: true };
  return { ok: false, status: 403, message: LOCKED_MSG };
}

// mutate(list) receives a plain copy of the classes and returns the new list
// (or { error: { status, message, current } }). opts: { baseVersion, note, skipLock }
async function editPlan(user, cycleId, mutate, opts = {}) {
  const cycle = await Cycle.findById(cycleId);
  if (!cycle) return { status: 404, body: { message: 'Cycle not found' } };
  let plan = await CyclePlan.findOne({ cycle: cycle._id });
  const before = (plan?.classes || []).map(k => ({ ...normalize(k), updatedAt: k.updatedAt || null, updatedBy: k.updatedBy || null }));
  const right = opts.skipLock && user.role === 'superadmin' ? { ok: true } : await editRight(user, cycle, before);
  if (!right.ok) return { status: right.status, body: { message: right.message } };
  if (opts.baseVersion != null && plan && Number(opts.baseVersion) !== plan.__v)
    return { status: 409, body: { message: 'Someone else changed this plan after you opened it. Reload to see their changes, then make yours again.', version: plan.__v } };

  const out = mutate(before.map(k => ({ ...k })));
  if (out && out.error) return { status: out.error.status || 400, body: { message: out.error.message, current: out.error.current } };
  const list = out.map(normalize);
  const nums = list.map(k => k.number);
  if (new Set(nums).size !== nums.length) return { status: 400, body: { message: 'Two classes have the same number.' } };
  // a class's trainer must be one of this batch's trainers (a name kept from earlier may stay)
  const batchTrainers = new Set(((await Batch.findById(cycle.batch).select('trainers').lean())?.trainers || []).map(sid));
  const wasThere = new Map(before.map(k => [k.number, sid(k.trainer)]));
  const stranger = list.find(k => k.trainer && !batchTrainers.has(k.trainer) && wasThere.get(k.number) !== k.trainer);
  if (stranger) return { status: 400, body: { message: `Class ${stranger.number}: that trainer is not on this batch.` } };

  const now = new Date();
  const prev = new Map(before.map(k => [k.number, k]));
  const classes = list.sort((a, b) => a.number - b.number).map(k => {
    const p = prev.get(k.number);
    const changed = !p || !same(p, k);
    return { ...k, updatedAt: changed ? now : p.updatedAt, updatedBy: changed ? user._id : p.updatedBy };
  });
  const text = describeChanges(before, classes);
  if (!plan) plan = new CyclePlan({ cycle: cycle._id, batch: cycle.batch, semester: cycle.semester, classes: [] });
  plan.classes = classes;
  plan.updatedBy = user._id;
  if (text) plan.changes = [...(plan.changes || []), { at: now, by: user._id, text: opts.note ? `${opts.note}: ${text}`.slice(0, 400) : text }].slice(-60);
  try { await plan.save(); }
  catch (err) {
    if (err.name === 'VersionError') return { status: 409, body: { message: 'Someone else saved this plan at the same moment. Reload and try again.' } };
    throw err;
  }
  if (isComplete(classes) && !cycle.track?.plan?.at) { await perf.stamp(cycle, 'plan', user); await cycle.save(); }
  await plan.populate('classes.trainer', 'name');
  return { status: 200, body: { classes: plan.classes, version: plan.__v, complete: isComplete(classes) } };
}

// Whole-list save (Cycle Plan page, AI tools). Replaces the list.
const saveCyclePlan = (user, cycleId, inputClasses, opts = {}) =>
  editPlan(user, cycleId, () => (Array.isArray(inputClasses) ? inputClasses : []), opts);

// One row: edit (number = existing), add (number not present + opts.add), remove.
function editRow(user, cycleId, number, patch, { baseUpdatedAt, add = false, remove = false } = {}) {
  return editPlan(user, cycleId, (list) => {
    const i = list.findIndex(k => k.number === Number(number));
    if (add) {
      if (i >= 0) return { error: { status: 409, message: `Class ${number} already exists.` } };
      return [...list, { ...patch, number: Number(number) }];
    }
    if (i < 0) return { error: { status: 404, message: `Class ${number} is not in the plan (maybe someone removed it). Reload.` } };
    const cur = list[i];
    if (baseUpdatedAt !== undefined && String(cur.updatedAt ? new Date(cur.updatedAt).toISOString() : '') !== String(baseUpdatedAt || ''))
      return { error: { status: 409, message: `Class ${number} was changed by someone else after you opened it. Reload to see it.`, current: cur } };
    if (remove) return list.filter((_, j) => j !== i);
    const next = { ...cur };
    for (const f of FIELDS) if (patch[f] !== undefined) next[f] = patch[f];
    return list.map((k, j) => j === i ? next : k);
  });
}

module.exports = { isComplete, editRight, editPlan, saveCyclePlan, editRow, describeChanges, LOCKED_MSG };
