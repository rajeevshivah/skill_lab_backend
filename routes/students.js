const express = require('express');
const Student = require('../models/Student');
const Batch   = require('../models/Batch');
const { protect, canAccessBatch } = require('../middleware/auth');
const router  = express.Router();

const MAX_PHOTO_SIZE = 2 * 1024 * 1024;

function sanitizePhoto(photoData) {
  if (!photoData) return { data: null, contentType: null };
  const match = photoData.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return { data: null, contentType: null };
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_PHOTO_SIZE) return null;
  return { data: match[2], contentType: match[1] };
}

// GET /api/students?batch=ID
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.batch)    filter.batch    = req.query.batch;
    if (req.query.semester) filter.semester = req.query.semester;
    const students = await Student.find(filter).select('-photo.data').sort('roll name');
    const result = students.map(s => ({
      _id: s._id, name: s.name, roll: s.roll, course: s.course,
      sem: s.sem, section: s.section, year: s.year,
      batch: s.batch, semester: s.semester, stats: s.stats,
      attendancePct: s.attendancePct, flagged: s.flagged,
      hasPhoto: !!s.photo?.contentType,
    }));
    res.json({ students: result, total: result.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/students/placement?semester=ID
router.get('/placement', async (req, res) => {
  try {
    const filter = {};
    if (req.query.semester) filter.semester = req.query.semester;
    const students = await Student.find(filter).select('-photo.data').populate('batch', 'name track');
    const scored = students.map(s => {
      const att = s.stats.totalSessions ? (s.stats.presentCount / s.stats.totalSessions) * 100 : 0;
      const score = s.stats.topperCount * 5 + s.stats.projectCount * 3 + att * 0.1 + (s.flagged ? 2 : 0);
      return {
        _id: s._id, name: s.name, roll: s.roll, course: s.course, sem: s.sem,
        section: s.section, batch: s.batch, stats: s.stats,
        attendancePct: Math.round(att), flagged: s.flagged,
        score: Math.round(score * 10) / 10,
      };
    }).sort((a, b) => b.score - a.score);
    res.json({ students: scored, total: scored.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/students/duplicates?semester=ID  — students whose roll appears in >1 batch
// (the "same student in two tracks" overlaps, for admin to resolve)
router.get('/duplicates', protect, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin')
      return res.status(403).json({ message: 'Admin only' });
    const filter = {};
    if (req.query.semester) filter.semester = req.query.semester;
    const students = await Student.find({ ...filter, roll: { $ne: '' } })
      .select('name roll batch')
      .populate('batch', 'name track');
    // group by roll, keep only rolls that appear in more than one batch
    const byRoll = {};
    for (const s of students) {
      const key = s.roll.toLowerCase();
      byRoll[key] = byRoll[key] || [];
      byRoll[key].push(s);
    }
    const groups = Object.values(byRoll)
      .filter(list => {
        const batchIds = new Set(list.map(s => String(s.batch?._id)));
        return batchIds.size > 1;   // same roll, different batches
      })
      .map(list => ({
        roll: list[0].roll,
        entries: list.map(s => ({
          studentId: s._id, name: s.name,
          batchId: s.batch?._id, batchName: s.batch?.name || '—', track: s.batch?.track || '',
        })),
      }));
    res.json({ groups, count: groups.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/students/:id/move  — move a student to a different batch (admin resolves overlap)
router.post('/:id/move', protect, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin')
      return res.status(403).json({ message: 'Admin only' });
    const { batch } = req.body;
    if (!batch) return res.status(400).json({ message: 'Target batch required' });
    const target = await Batch.findById(batch);
    if (!target) return res.status(404).json({ message: 'Target batch not found' });
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: 'Student not found' });
    student.batch = batch;
    student.semester = target.semester;
    student.updatedBy = req.user._id;
    await student.save();
    res.json({ student });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.get('/:id/photo', async (req, res) => {
  try {
    const s = await Student.findById(req.params.id).select('photo');
    if (!s?.photo?.data) return res.status(404).json({ message: 'No photo' });
    res.json({ photo: `data:${s.photo.contentType};base64,${s.photo.data}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/students
router.post('/', protect, async (req, res) => {
  try {
    const { name, roll, course, sem, section, year, batch, photo } = req.body;
    if (!name || !batch) return res.status(400).json({ message: 'Name and batch required' });
    if (!(await canAccessBatch(req.user, batch)))
      return res.status(403).json({ message: 'You can only add students to your assigned batch' });
    const batchDoc = await Batch.findById(batch);
    if (!batchDoc) return res.status(404).json({ message: 'Batch not found' });
    let photoDoc = { data: null, contentType: null };
    if (photo) {
      const p = sanitizePhoto(photo);
      if (p === null) return res.status(400).json({ message: 'Photo too large. Max 2MB.' });
      photoDoc = p;
    }
    const student = await Student.create({
      name, roll, course, sem, section, year,
      batch, semester: batchDoc.semester, photo: photoDoc, addedBy: req.user._id,
    });
    res.status(201).json({ student });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/students/bulk
router.post('/bulk', protect, async (req, res) => {
  try {
    const { batch, rows } = req.body;
    if (!batch || !Array.isArray(rows) || !rows.length)
      return res.status(400).json({ message: 'Batch and rows required' });
    if (!(await canAccessBatch(req.user, batch)))
      return res.status(403).json({ message: 'You can only import into your assigned batch' });
    const batchDoc = await Batch.findById(batch);
    if (!batchDoc) return res.status(404).json({ message: 'Batch not found' });

    const docs = rows
      .filter(r => r.name && r.name.trim())
      .map(r => ({
        name: r.name.trim(), roll: (r.roll || '').trim(),
        course: (r.course || '').trim(), sem: (r.sem || '').trim(),
        section: (r.section || '').trim(), year: (r.year || '').trim(),
        batch, semester: batchDoc.semester, addedBy: req.user._id,
      }));

    // Detect students whose roll already exists in ANOTHER batch this semester
    // (the "same student sitting in two tracks" case). We still import them —
    // the overlap is flagged for the admin to resolve, not blocked.
    const rolls = docs.map(d => d.roll).filter(Boolean);
    let duplicates = [];
    if (rolls.length) {
      const existing = await Student.find({
        semester: batchDoc.semester,
        roll: { $in: rolls },
        batch: { $ne: batch },
      }).populate('batch', 'name track');
      duplicates = existing.map(e => ({
        roll: e.roll, name: e.name,
        otherBatch: e.batch ? e.batch.name : 'another batch',
        otherTrack: e.batch ? e.batch.track : '',
      }));
    }

    const created = await Student.insertMany(docs);
    res.status(201).json({
      imported: created.length,
      duplicates,           // array of {roll,name,otherBatch,otherTrack} — may be empty
      duplicateCount: duplicates.length,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/students/:id
router.put('/:id', protect, async (req, res) => {
  try {
    const existing = await Student.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Student not found' });
    if (!(await canAccessBatch(req.user, existing.batch)))
      return res.status(403).json({ message: 'You can only edit students in your batch' });
    const { name, roll, course, sem, section, year, flagged, photo } = req.body;
    if (name !== undefined)    existing.name = name;
    if (roll !== undefined)    existing.roll = roll;
    if (course !== undefined)  existing.course = course;
    if (sem !== undefined)     existing.sem = sem;
    if (section !== undefined) existing.section = section;
    if (year !== undefined)    existing.year = year;
    if (flagged !== undefined) existing.flagged = flagged;
    if (photo !== undefined) {
      if (photo === null || photo === '') existing.photo = { data: null, contentType: null };
      else {
        const p = sanitizePhoto(photo);
        if (p === null) return res.status(400).json({ message: 'Photo too large. Max 2MB.' });
        existing.photo = p;
      }
    }
    existing.updatedBy = req.user._id;
    await existing.save();
    res.json({ student: existing });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/students/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: 'Student not found' });
    if (req.user.role === 'cotrainer')
      return res.status(403).json({ message: 'Co-trainers cannot delete students' });
    if (!(await canAccessBatch(req.user, student.batch)))
      return res.status(403).json({ message: 'You can only delete students in your batch' });
    await Student.findByIdAndDelete(req.params.id);
    res.json({ message: 'Student deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
