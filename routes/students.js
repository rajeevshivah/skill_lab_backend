const express   = require('express');
const Student   = require('../models/Student');
const Batch     = require('../models/Batch');
const CycleMark = require('../models/CycleMark');
const Topper    = require('../models/Topper');
const DailyLog  = require('../models/DailyLog');
const ClassPulse = require('../models/ClassPulse');
const ProjectSubmission = require('../models/ProjectSubmission');
const { protect, canAccessBatch, noCotrainer, seesAll } = require('../middleware/auth');
const studentMerge = require('../services/studentMerge');
const tempRoll = require('../services/tempRoll');
const files = require('../services/fileStore');
const router  = express.Router();

const MAX_IMPORT_ROWS = 1000;
const ROLL_RE = /^[A-Za-z0-9][A-Za-z0-9._/\-]{0,31}$/;

// Same checks as the student's own upload (services/studentPhoto.js): real JPG/PNG/WEBP, ≤ 400 KB.
// Returns { data, contentType } | { data: null } for "no photo" | null when the file is not acceptable.
function sanitizePhoto(photoData) {
  try { return require('../services/studentPhoto').parse(photoData) || { data: null, contentType: null }; }
  catch { return null; }
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
// Same roll whatever the letter case / stray spaces ("bca12" = "BCA12 ")
const rollRe = (roll) => new RegExp(`^\\s*${String(roll).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

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
      _id: s._id, name: s.name, roll: s.roll, rollTemporary: !!s.rollTemporary, course: s.course,
      sem: s.sem, section: s.section, year: s.year,
      batch: s.batch, semester: s.semester, stats: s.stats,
      attendancePct: s.attendancePct, flagged: s.flagged,
      hasPhoto: files.has(s.photo),
    }));
    res.json({ students: result, total: result.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/students/top?semester=ID&batch=ID — who is doing well (services/topStudents.js).
// Trainers: their own batches. Admin and management: every batch.
router.get('/top', protect, async (req, res) => {
  try { res.json(await require('../services/topStudents').topStudents(req.user, req.query)); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/students/duplicates?semester=ID
// A roll appearing twice anywhere — across two batches (track overlap) or
// twice inside one batch (a double import).
router.get('/duplicates', protect, async (req, res) => {
  try {
    if (!seesAll(req.user))
      return res.status(403).json({ message: 'Admin only' });
    const filter = {};
    if (req.query.semester) filter.semester = req.query.semester;
    const students = await Student.find({ ...filter, roll: { $ne: '' } })
      .select('name roll batch course sem section stats login.activatedAt createdAt')
      .populate('batch', 'name track');
    const byRoll = {};
    for (const s of students) {
      const key = s.roll.trim().toLowerCase();
      byRoll[key] = byRoll[key] || [];
      byRoll[key].push(s);
    }
    const dupes = Object.values(byRoll).filter(list => list.length > 1);
    const ids = dupes.flat().map(s => s._id);
    const marks = await CycleMark.find({ student: { $in: ids }, status: 'evaluated' }).select('student').lean();
    const markCount = (id) => marks.filter(m => String(m.student) === String(id)).length;
    const groups = dupes.map(list => ({
        roll: list[0].roll,
        sameBatch: new Set(list.map(s => String(s.batch?._id))).size === 1,
        entries: list.sort((a, b) => a.createdAt - b.createdAt).map(s => ({
          studentId: s._id, name: s.name, course: s.course, sem: s.sem, section: s.section,
          batchId: s.batch?._id, batchName: s.batch?.name || '—', track: s.batch?.track || '',
          marks: markCount(s._id), present: s.stats?.presentCount || 0, signedUp: !!s.login?.activatedAt,
        })),
      }));
    res.json({ groups, count: groups.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/students/:id/merge  { into, preview }  (admin)
// :id is the duplicate record; everything it carries moves to `into`, then it is
// removed (services/studentMerge.js). preview=true only counts what would move.
// The batch's trainers may merge their own students too (not co-trainers).
router.post('/:id/merge', protect, noCotrainer, async (req, res) => {
  try {
    const { into, preview } = req.body || {};
    if (!into) return res.status(400).json({ message: 'Which record to keep (into)?' });
    const dup = await Student.findById(req.params.id).select('batch').setOptions({ withDemo: true });
    if (!dup) return res.status(404).json({ message: 'Student not found' });
    if (!(await canAccessBatch(req.user, dup.batch))) return res.status(403).json({ message: 'You can only merge students in your own batch' });
    const out = preview ? await studentMerge.preview(into, req.params.id) : await studentMerge.merge(into, req.params.id, req.user._id);
    res.json(out);
  } catch (err) {
    if (err instanceof studentMerge.MergeError) return res.status(400).json({ message: err.message });
    res.status(500).json({ message: err.message });
  }
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
    const clash = student.roll && await Student.findOne({ batch, roll: rollRe(student.roll), _id: { $ne: student._id } });
    if (clash) return res.status(400).json({ message: `Roll ${student.roll} is already in ${target.name} (${clash.name}). Merge them on the Duplicates page instead.` });
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
    const url = s && (files.publicUrl(s.photo) || await files.dataUrl(s.photo));
    if (!url) return res.status(404).json({ message: 'No photo' });
    res.json({ photo: url });
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
      const clash = await Student.findOne({ batch, roll: rollRe(v.doc.roll) });
      if (clash)
        return res.status(400).json({ message: `Roll ${v.doc.roll} already belongs to ${clash.name} in this batch.` });
    } else {
      // no roll yet (lateral entry, late admission) → a temporary ID to sign in with
      [v.doc.roll] = await tempRoll.issue(1);
      v.doc.rollTemporary = true;
    }

    let photoDoc = { data: null, contentType: null };
    if (photo) {
      const p = sanitizePhoto(photo);
      if (p === null) return res.status(400).json({ message: 'Photo must be a JPG, PNG or WEBP under 400 KB.' });
      photoDoc = await files.store(p, 'photos');
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

    const noRoll = docs.filter(d => !d.roll);
    if (preview) {
      return res.json({
        preview: true,
        willImport: docs.length, temporaryIds: noRoll.length,   // rows with no roll get a TMP- ID
        sample: docs.slice(0, 5).map(d => ({
          roll: d.roll, name: d.name, course: d.course, sem: d.sem, section: d.section,
        })),
        skipped, skippedCount: skipped.length,
        duplicates, duplicateCount: duplicates.length,
      });
    }

    if (noRoll.length) (await tempRoll.issue(noRoll.length)).forEach((r, i) => { noRoll[i].roll = r; noRoll[i].rollTemporary = true; });
    const created = docs.length ? await Student.insertMany(docs) : [];
    res.status(201).json({
      imported: created.length, temporaryIds: noRoll.map(d => ({ name: d.name, roll: d.roll })),
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
          batch: existing.batch, roll: rollRe(v.doc.roll), _id: { $ne: existing._id },
        });
        if (clash)
          return res.status(400).json({ message: `Roll ${v.doc.roll} already belongs to ${clash.name} in this batch.` });
      }
      // a roll cleared → a new temporary ID (a student always has something to sign in with);
      // a real roll typed over a temporary one → it becomes the student's roll, sign-in keeps working
      if (!v.doc.roll) { [v.doc.roll] = await tempRoll.issue(1); v.doc.rollTemporary = true; }
      else if (v.doc.roll.toLowerCase() !== (existing.roll || '').toLowerCase()) v.doc.rollTemporary = tempRoll.isTemp(v.doc.roll);
      Object.assign(existing, v.doc);
    }

    if (flagged !== undefined) existing.flagged = flagged;
    if (req.body.demo !== undefined && req.user.role === 'superadmin') existing.demo = !!req.body.demo;   // admin only
    if (photo !== undefined) {
      if (photo === null || photo === '') existing.photo = { data: null, contentType: null };
      else {
        const p = sanitizePhoto(photo);
        if (p === null) return res.status(400).json({ message: 'Photo must be a JPG, PNG or WEBP under 400 KB.' });
        existing.photo = await files.store(p, 'photos');
      }
    }
    existing.updatedBy = req.user._id;
    await existing.save();
    // Same photo on the Hall of Fame wherever this student is in a Top 3
    if (photo !== undefined) await require('../services/studentPhoto').sync(existing._id);
    res.json({ student: existing });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/students/:id
// Refuses when the student carries real history (evaluated marks, a remark, or
// top-3 finishes) — fix details with PUT, or MERGE a duplicate instead. Empty
// "not evaluated" mark rows (a marks sheet saves one for every student) don't
// count and go with the student. A superadmin can pass ?force=1 to delete the
// student and their history together. Their attendance ticks, class check-ins
// and project submissions are removed too, so batch numbers stay right.
router.delete('/:id', protect, noCotrainer, async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: 'Student not found' });
    if (!(await canAccessBatch(req.user, student.batch)))
      return res.status(403).json({ message: 'You can only delete students in your batch' });

    const force = req.query.force === '1' && req.user.role === 'superadmin';
    const realMark = { student: student._id, $or: [{ status: 'evaluated' }, { assessment: { $ne: null } }, { project: { $ne: null } }, { remark: { $nin: ['', null] } }] };
    const [markCount, oldTops, cycleTops] = await Promise.all([
      CycleMark.countDocuments(realMark),
      Topper.countDocuments({ student: student._id }),
      require('../models/Cycle').countDocuments({ 'report.top3.student': student._id }),
    ]);
    const topperCount = oldTops + cycleTops;

    if ((markCount || topperCount) && !force) {
      const twin = student.roll && await Student.exists({ batch: student.batch, roll: rollRe(student.roll), _id: { $ne: student._id } });
      return res.status(409).json({
        message: `${student.name} has ${markCount} mark(s) and ${topperCount} top-3 finish(es). ` +
                 (twin ? 'This roll is in the batch twice — use Merge so nothing is lost.' : 'Edit their details instead of removing them — deleting loses that history.'),
        markCount, topperCount, needsForce: true, duplicate: !!twin,
      });
    }

    await CycleMark.deleteMany({ student: student._id });            // empty rows (and real ones when forced)
    if (force) await Topper.deleteMany({ student: student._id });
    for (const log of await DailyLog.find({ 'attendance.student': student._id })) {   // their attendance ticks
      log.attendance = log.attendance.filter(a => String(a.student) !== String(student._id));
      await log.save();
    }
    await Promise.all([
      ClassPulse.deleteMany({ student: student._id }),
      ProjectSubmission.deleteMany({ student: student._id }),
    ]);
    await Student.deleteOne({ _id: student._id });
    await require('../services/attendanceStats').recomputeBatchStats(student.batch);
    res.json({ message: 'Student deleted', removedMarks: force ? markCount : 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Exported for tests — pure helpers, no database involved.
router.__test = { validateRow, clean, ROLL_RE };

module.exports = router;
