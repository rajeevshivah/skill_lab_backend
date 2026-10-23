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
  mode: b.mode === 'mark' ? 'mark' : 'shift',
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
    res.json({ holidays: hs.map(h => ({ _id: h._id, from: h.from, to: h.to, title: h.title, mode: h.mode,
      batches: (h.batches || []).map(b => b.name), moved: h.moves.length, cycleChanges: h.cycleChanges.length,
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
    res.status(201).json({ ok: true, holidayId: r.holiday._id, moved: r.holiday.moves.length, cycleChanges: r.holiday.cycleChanges.length });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// DELETE /api/settings/holidays/:id — remove it and move classes back
router.delete('/holidays/:id', protect, superadminOnly, async (req, res) => {
  try {
    const r = await cal.remove(req.params.id, req.user);
    res.json({ ok: true, skipped: r.skipped });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;
