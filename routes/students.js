const express   = require('express');
const Student   = require('../models/Student');
const Batch     = require('../models/Batch');
const CycleMark = require('../models/CycleMark');
const Topper    = require('../models/Topper');
const { protect, canAccessBatch, noCotrainer } = require('../middleware/auth');
const router  = express.Router();

const MAX_PHOTO_SIZE  = 2 * 1024 * 1024;
const MAX_IMPORT_ROWS = 1000;
const ROLL_RE = /^[A-Za-z0-9][A-Za-z0-9._/\-]{0,31}$/;

function sanitizePhoto(photoData) {
  if (!photoData) return { data: null, contentType: null };
  const match = photoData.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return { data: null, contentType: null };
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_PHOTO_SIZE) return null;
  return { data: match[2], contentType: match[1] };
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Validate one roster row. Returns { ok, doc? , reason? }
function validateRow(raw) {
  const name    = clean(raw.name);
  const roll    = clean(raw.roll);
  const course  = clean(raw.course);
  const sem     = clean(raw.sem);
  const section = clean(raw.section);
  const year    = clean(raw.year);

  if (!name)             return { ok: false, reason: 'no name' };
  if (name.length > 120) return { ok: false, reason: 'name too long' };
  if (/^(name|student name|roll|roll number)$/i.test(name))
    return { ok: false, reason: 'looks like a header row' };
  if (roll && !ROLL_RE.test(roll))
    return { ok: false, reason: 'roll has spaces or unusual characters' };

  return { ok: true, doc: { name, roll, course, sem, section, year } };
}

// GET /api/students?batch=ID
// Staff only. Any signed-in trainer may READ any batch (other batches open
// read-only in the UI); writing is still limited to their own batches.
router.get('/', protect, async (req, res) => {
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
router.get('/placement', protect, async (req, res) => {
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

// GET /api/students/duplicates?semester=ID
// A roll appearing twice anywhere — across two batches (track overlap) or
// twice inside one batch (a double import).
router.get('/duplicates', protect, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin')
      return res.status(403).json({ message: 'Admin only' });
    const filter = {};
    if (req.query.semester) filter.semester = req.query.semester;
    const students = await Student.find({ ...filter, roll: { $ne: '' } })
      .select('name roll batch')
      .populate('batch', 'name track');
    const byRoll = {};
    for (const s of students) {
      const key = s.roll.toLowerCase();
      byRoll[key] = byRoll[key] || [];
      byRoll[key].push(s);
    }
    const groups = Object.values(byRoll)
      .filter(list => list.length > 1)
      .map(list => ({
        roll: list[0].roll,
        sameBatch: new Set(list.map(s => String(s.batch?._id))).size === 1,
        entries: list.map(s => ({
          studentId: s._id, name: s.name,
          batchId: s.batch?._id, batchName: s.batch?.name || '—', track: s.batch?.track || '',
        })),
      }));
    res.json({ groups, count: groups.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/students/:id/move  — move a student to a different batch
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

router.get('/:id/photo', protect, async (req, res) => {
  try {
    const s = await Student.findById(req.params.id).select('photo');
    if (!s?.photo?.data) return res.status(404).json({ message: 'No photo' });
    res.json({ photo: `data:${s.photo.contentType};base64,${s.photo.data}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/students  — add one
router.post('/', protect, async (req, res) => {
  try {
    const { batch, photo } = req.body;
    if (!batch) return res.status(400).json({ message: 'Batch required' });
    if (!(await canAccessBatch(req.user, batch)))
      return res.status(403).json({ message: 'You can only add students to your assigned batch' });
    const batchDoc = await Batch.findById(batch);
    if (!batchDoc) return res.status(404).json({ message: 'Batch not found' });

    const v = validateRow(req.body);
    if (!v.ok) return res.status(400).json({ message: `Cannot add student — ${v.reason}.` });

    if (v.doc.roll) {
      const clash = await Student.findOne({ batch, roll: v.doc.roll });
      if (clash)
        return res.status(400).json({ message: `Roll ${v.doc.roll} already belongs to ${clash.name} in this batch.` });
    }

    let photoDoc = { data: null, contentType: null };
    if (photo) {
      const p = sanitizePhoto(photo);
      if (p === null) return res.status(400).json({ message: 'Photo too large. Max 2MB.' });
      photoDoc = p;
    }
    const student = await Student.create({
      ...v.doc, batch, semester: batchDoc.semester, photo: photoDoc, addedBy: req.user._id,
    });
    res.status(201).json({ student });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/students/bulk           — import a roster
// POST /api/students/bulk?preview=1 — validate only, write nothing
//
// Rows that fail validation, repeat inside the paste, or already exist in THIS
// batch are skipped and reported line by line. Rows whose roll exists in
// ANOTHER batch are imported and flagged as a track overlap.
router.post('/bulk', protect, async (req, res) => {
  try {
    const preview = req.query.preview === '1' || req.body.preview === true;
    const { batch, rows } = req.body;
    if (!batch || !Array.isArray(rows) || !rows.length)
      return res.status(400).json({ message: 'Batch and rows required' });
    if (rows.length > MAX_IMPORT_ROWS)
      return res.status(400).json({ message: `Too many rows (${rows.length}). Import at most ${MAX_IMPORT_ROWS} at a time.` });
    if (!(await canAccessBatch(req.user, batch)))
      return res.status(403).json({ message: 'You can only import into your assigned batch' });
    const batchDoc = await Batch.findById(batch);
    if (!batchDoc) return res.status(404).json({ message: 'Batch not found' });

    // Rolls already in this batch — re-importing them would duplicate the student.
    const existingHere = await Student.find({ batch }).select('roll name');
    const takenHere = new Map();
    existingHere.forEach(s => { if (s.roll) takenHere.set(s.roll.toLowerCase(), s.name); });

    const docs = [], skipped = [], seenInPayload = new Map();

    rows.forEach((raw, i) => {
      const line = i + 1;
      const v = validateRow(raw);
      if (!v.ok) {
        skipped.push({ line, roll: clean(raw.roll), name: clean(raw.name), reason: v.reason });
        return;
      }
      const key = v.doc.roll.toLowerCase();
      if (v.doc.roll && seenInPayload.has(key)) {
        skipped.push({ line, roll: v.doc.roll, name: v.doc.name,
                       reason: `duplicate of line ${seenInPayload.get(key)} in this paste` });
        return;
      }
      if (v.doc.roll && takenHere.has(key)) {
        skipped.push({ line, roll: v.doc.roll, name: v.doc.name,
                       reason: `already in this batch as ${takenHere.get(key)}` });
        return;
      }
      if (v.doc.roll) seenInPayload.set(key, line);
      docs.push({ ...v.doc, batch, semester: batchDoc.semester, addedBy: req.user._id });
    });

    // Same roll in another batch this semester (track overlap) — allowed, flagged.
    const rolls = docs.map(d => d.roll).filter(Boolean);
    let duplicates = [];
    if (rolls.length) {
      const existing = await Student.find({
        semester: batchDoc.semester, roll: { $in: rolls }, batch: { $ne: batch },
      }).populate('batch', 'name track');
      duplicates = existing.map(e => ({
        roll: e.roll, name: e.name,
        otherBatch: e.batch ? e.batch.name : 'another batch',
        otherTrack: e.batch ? e.batch.track : '',
      }));
    }

    if (preview) {
      return res.json({
        preview: true,
        willImport: docs.length,
        sample: docs.slice(0, 5).map(d => ({
          roll: d.roll, name: d.name, course: d.course, sem: d.sem, section: d.section,
        })),
        skipped, skippedCount: skipped.length,
        duplicates, duplicateCount: duplicates.length,
      });
    }

    const created = docs.length ? await Student.insertMany(docs) : [];
    res.status(201).json({
      imported: created.length,
      skipped, skippedCount: skipped.length,
      duplicates, duplicateCount: duplicates.length,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/students/:id  — edit roll / name / course / sem / section / flag / photo
router.put('/:id', protect, async (req, res) => {
  try {
    const existing = await Student.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Student not found' });
    if (!(await canAccessBatch(req.user, existing.batch)))
      return res.status(403).json({ message: 'You can only edit students in your batch' });

    const { name, roll, course, sem, section, year, flagged, photo } = req.body;

    // Validate identity fields only when they are actually being changed, so a
    // bare flag toggle can't trip the name check.
    const touchesIdentity = [name, roll, course, sem, section, year].some(v => v !== undefined);
    if (touchesIdentity) {
      const merged = {
        name:    name    !== undefined ? name    : existing.name,
        roll:    roll    !== undefined ? roll    : existing.roll,
        course:  course  !== undefined ? course  : existing.course,
        sem:     sem     !== undefined ? sem     : existing.sem,
        section: section !== undefined ? section : existing.section,
        year:    year    !== undefined ? year    : existing.year,
      };
      const v = validateRow(merged);
      if (!v.ok) return res.status(400).json({ message: `Cannot save — ${v.reason}.` });

      if (v.doc.roll && v.doc.roll.toLowerCase() !== (existing.roll || '').toLowerCase()) {
        const clash = await Student.findOne({
          batch: existing.batch, roll: v.doc.roll, _id: { $ne: existing._id },
        });
        if (clash)
          return res.status(400).json({ message: `Roll ${v.doc.roll} already belongs to ${clash.name} in this batch.` });
      }
      Object.assign(existing, v.doc);
    }

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
// Refuses when the student carries history (marks or top-3 finishes) — deleting
// them orphans those records. Fix details with PUT instead. A superadmin can
// pass ?force=1 to delete the student and their history together.
router.delete('/:id', protect, noCotrainer, async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: 'Student not found' });
    if (!(await canAccessBatch(req.user, student.batch)))
      return res.status(403).json({ message: 'You can only delete students in your batch' });

    const force = req.query.force === '1' && req.user.role === 'superadmin';
    const [markCount, topperCount] = await Promise.all([
      CycleMark.countDocuments({ student: student._id }),
      Topper.countDocuments({ student: student._id }),
    ]);

    if ((markCount || topperCount) && !force) {
      return res.status(409).json({
        message: `${student.name} has ${markCount} cycle mark(s) and ${topperCount} top-3 finish(es). ` +
                 `Edit their details instead of removing them — deleting loses that history.`,
        markCount, topperCount, needsForce: true,
      });
    }

    if (force) {
      await CycleMark.deleteMany({ student: student._id });
      await Topper.deleteMany({ student: student._id });
    }
    await Student.findByIdAndDelete(req.params.id);
    res.json({ message: 'Student deleted', removedMarks: force ? markCount : 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Exported for tests — pure helpers, no database involved.
router.__test = { validateRow, clean, ROLL_RE };

module.exports = router;
