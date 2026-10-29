// ─────────────────────────────────────────────────────────────────────
//  /api/settings — admin controls: batch timetables and holidays.
//  (Holidays: see services/calendar.js for exactly what moves.)
// ─────────────────────────────────────────────────────────────────────
const express  = require('express');
const mongoose = require('mongoose');
const Batch    = require('../models/Batch');
const Semester = require('../models/Semester');
const Holiday  = require('../models/Holiday');
const { protect, superadminOnly } = require('../middleware/auth');
const cal      = require('../services/calendar');
const router   = express.Router();

async function activeSemester(res) {
  const s = await Semester.findOne({ status: 'active' });
  if (!s) res.status(400).json({ message: 'No active semester' });
  return s;
}
const input = (b) => ({
  from: b.from, to: b.to || b.from, title: String(b.title || 'Holiday').slice(0, 80),
  batchIds: (b.batchIds || []).filter(x => mongoose.isValidObjectId(x)),
  mode: ['mark', 'keep', 'makeup'].includes(b.mode) ? b.mode : 'shift',
  makeupDate: b.makeupDate || null,
});

// GET /api/settings/timetables
router.get('/timetables', protect, superadminOnly, async (req, res) => {
  try {
    const sem = await activeSemester(res); if (!sem) return;
    const bs = await Batch.find({ semester: sem._id }).sort('name').lean();
    const rows = [];
    for (const b of bs) { const t = await cal.batchDays(b); rows.push({ _id: b._id, name: b.name, track: b.track, days: t.days, source: t.source }); }
    res.json({ batches: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/settings/timetables/:id { days: [1,2,3] }
router.put('/timetables/:id', protect, superadminOnly, async (req, res) => {
  try {
    const days = [...new Set((req.body.days || []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    const b = await Batch.findByIdAndUpdate(req.params.id, { $set: { 'schedule.days': days } }, { new: true });
    if (!b) return res.status(404).json({ message: 'Batch not found' });
    res.json({ ok: true, days });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/settings/holidays
router.get('/holidays', protect, async (req, res) => {
  try {
    const sem = await activeSemester(res); if (!sem) return;
    const hs = await Holiday.find({ semester: sem._id }).sort('from').populate('batches', 'name').populate('createdBy', 'name').lean();
    res.json({ holidays: hs.map(h => ({ _id: h._id, from: h.from, to: h.to, title: h.title, mode: h.mode, makeupDate: h.makeupDate || null,
      batches: (h.batches || []).map(b => b.name), moved: h.moves.length, merged: (h.merges || []).length, cycleChanges: h.cycleChanges.length,
      by: h.createdBy?.name || '', at: h.createdAt })) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/settings/holidays/preview — nothing is saved
router.post('/holidays/preview', protect, superadminOnly, async (req, res) => {
  try {
    const sem = await activeSemester(res); if (!sem) return;
    res.json(await cal.preview(input(req.body), sem));
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST /api/settings/holidays — mark the holiday (and move classes if mode = shift)
router.post('/holidays', protect, superadminOnly, async (req, res) => {
  try {
    const sem = await activeSemester(res); if (!sem) return;
    const r = await cal.apply(input(req.body), sem, req.user);
    res.status(201).json({ ok: true, holidayId: r.holiday._id, moved: r.holiday.moves.length, merged: (r.holiday.merges || []).length, cycleChanges: r.holiday.cycleChanges.length });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// DELETE /api/settings/holidays/:id — remove it and move classes back
router.delete('/holidays/:id', protect, superadminOnly, async (req, res) => {
  try {
    const r = await cal.remove(req.params.id, req.user);
    res.json({ ok: true, skipped: r.skipped });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── Top students: score weights and label cut-offs (Organization.settings) ──
const Organization = require('../models/Organization');
const tenant = require('../services/tenant');
const top = require('../services/topStudents');

// GET /api/settings/student-score
router.get('/student-score', protect, async (req, res) => {
  try { res.json({ studentScore: await top.weights(), defaults: top.DEFAULTS }); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/settings/student-score { marks, attendance, projects, good, excellent }
router.put('/student-score', protect, superadminOnly, async (req, res) => {
  try {
    const v = {};
    for (const k of Object.keys(top.DEFAULTS)) {
      const n = Number(req.body?.[k]);
      if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ message: `${k} must be a number from 0 to 100.` });
      v[k] = Math.round(n);
    }
    if (!(v.marks + v.attendance + v.projects)) return res.status(400).json({ message: 'At least one weight must be above 0.' });
    if (v.good > v.excellent) return res.status(400).json({ message: '"Good" cut-off cannot be above "Excellent".' });
    await Organization.updateOne({ _id: tenant.currentOrg() }, { $set: { 'settings.studentScore': v } });
    require('../middleware/org').forget();
    res.json({ studentScore: v });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET/PUT /api/settings/student-signup { mode: 'personal' | 'batch' }
router.get('/student-signup', protect, async (req, res) => {
  try { res.json({ mode: await require('../services/studentCodes').mode() }); }
  catch (err) { res.status(500).json({ message: err.message }); }
});
router.put('/student-signup', protect, superadminOnly, async (req, res) => {
  try {
    const mode = req.body?.mode;
    if (!['personal', 'batch'].includes(mode)) return res.status(400).json({ message: 'mode must be personal or batch' });
    await Organization.updateOne({ _id: tenant.currentOrg() }, { $set: { 'settings.studentSignup': mode } });
    require('../middleware/org').forget();
    res.json({ mode });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET/PUT /api/settings/student-creation { mode: 'trainers' | 'admin' }
router.get('/student-creation', protect, async (req, res) => {
  try { res.json({ mode: await require('../services/people').creationMode() }); }
  catch (err) { res.status(500).json({ message: err.message }); }
});
router.put('/student-creation', protect, superadminOnly, async (req, res) => {
  try {
    const mode = req.body?.mode;
    if (!['trainers', 'admin'].includes(mode)) return res.status(400).json({ message: 'mode must be trainers or admin' });
    await Organization.updateOne({ _id: tenant.currentOrg() }, { $set: { 'settings.studentCreation': mode } });
    require('../middleware/org').forget();
    res.json({ mode });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
