// ============================================================
//  TEACHER — MARKS, GRADEBOOK & RESULTS SUBMISSION (Part A)
//  Mounted at /api/lms/academic/teacher/marks
//  ------------------------------------------------------------
//  A4  PIN gate: every endpoint except /pin/* requires a live
//      marks-session token (X-Marks-Token) obtained with the PIN.
//  A3/A5 Gradebook with weightage auto-conversion (fully editable).
//  B2.b Mid/Final Total Marks per course.
//  A7  Results Submission — publish one subject (PIN) → LOCKED.
//  A8  Final submission of all subjects to the Exam Controller
//      (PIN) → SUBMITTED, permanently immutable for every role.
// ============================================================
const express = require('express');
const prisma = require('../../../utils/prisma');
const { lmsAuth, lmsRequireRole } = require('../../../middleware/lmsAuth');
const { asyncHandler, httpError } = require('../../../utils/lmsHelpers');
const { audit } = require('../../../utils/lmsAudit');
const { notify, notifyMany } = require('../../../utils/lmsNotify');
const realtime = require('../../../utils/lmsRealtime');
const pin = require('../../../utils/marksPin');
const gradebook = require('../../../services/gradebookService');
const { assertEditable } = require('../../../utils/resultWorkflow');

const router = express.Router();
router.use(lmsAuth);
router.use(lmsRequireRole('Teacher', 'CourseCoordinator'));

// Marks endpoints are never cached by the browser (no stale view after back/refresh).
router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// ---------------- PIN (no marks session needed) ----------------
router.get('/pin/status', asyncHandler(async (req, res) => {
  res.json(await pin.status(req.lmsUser.id));
}));

router.post('/pin/setup', asyncHandler(async (req, res) => {
  const out = await pin.setupPin(req.lmsUser.id, req.body || {});
  await audit(req, 'MARKS_PIN_SETUP', 'TeacherMarksPin', req.lmsUser.id, {});
  res.status(201).json({ message: 'Marks PIN set successfully', ...out });
}));

router.post('/pin/unlock', asyncHandler(async (req, res) => {
  try {
    const out = await pin.unlock(req.lmsUser.id, (req.body || {}).pin);
    await audit(req, 'MARKS_PIN_UNLOCK', 'TeacherMarksPin', req.lmsUser.id, {});
    res.json(out);
  } catch (e) {
    await audit(req, 'MARKS_PIN_FAILED', 'TeacherMarksPin', req.lmsUser.id, { after: { status: e.status } });
    res.status(e.status || 401).json({ error: e.message, code: e.code, attemptsRemaining: e.attemptsRemaining, lockedUntil: e.lockedUntil });
  }
}));

router.post('/pin/change', asyncHandler(async (req, res) => {
  const out = await pin.changePin(req.lmsUser.id, req.body || {});
  await audit(req, 'MARKS_PIN_CHANGE', 'TeacherMarksPin', req.lmsUser.id, {});
  res.json({ message: 'Marks PIN changed. All other open Marks sessions were signed out.', ...out });
}));

// Everything below requires a valid PIN session.
router.use(pin.requireMarksSession);

// ---------------- helpers ----------------
async function ownedOffering(req, id) {
  const offering = await prisma.courseOffering.findFirst({
    where: { id: Number(id), isDeleted: false },
    include: { course: { include: { program: true, semester: true } }, term: true },
  });
  if (!offering) throw httpError(404, 'Offering not found');
  if (req.lmsUser.role === 'Teacher' && offering.teacherId !== req.lmsUser.id) {
    throw httpError(403, 'You are not assigned to this course offering');
  }
  return offering;
}

function assertOfferingOpen(offering) {
  if (offering.resultSubmittedAt) throw httpError(409, 'Results for this subject were submitted to the Exam Controller and are permanently locked.');
  if (offering.resultLockedAt) throw httpError(409, 'This subject result has been published and locked. It can no longer be edited.');
}

async function syncAndBroadcast(offeringId, studentIds) {
  const touched = await gradebook.syncResults(offeringId);
  const ids = studentIds && studentIds.length ? studentIds : touched;
  realtime.emitTo(ids, 'result', { action: 'marks-updated', offeringId });
  return touched;
}

async function myTermOfferings(req) {
  const term = await prisma.academicTerm.findFirst({ where: { isCurrent: true, isActive: true } });
  return prisma.courseOffering.findMany({
    where: { isDeleted: false, teacherId: req.lmsUser.id, ...(term ? { termId: term.id } : {}) },
    include: { course: { include: { program: true, semester: true } }, term: true },
    orderBy: { id: 'asc' },
  });
}

function completion(gb) {
  let totalCells = 0; let graded = 0; let complete = 0;
  for (const row of gb.rows) {
    const cells = Object.values(row.cells);
    const g = cells.filter((c) => !c.pending).length;
    totalCells += cells.length; graded += g;
    if (cells.length && g === cells.length) complete += 1;
  }
  return {
    students: gb.rows.length,
    studentsComplete: complete,
    cellsTotal: totalCells,
    cellsGraded: graded,
    percentComplete: totalCells ? Math.round((graded / totalCells) * 100) : 0,
  };
}

// ---------------- Gradebook ----------------
router.get('/offerings', asyncHandler(async (req, res) => {
  const offerings = await (req.lmsUser.role === 'Teacher' ? myTermOfferings(req) : prisma.courseOffering.findMany({ where: { isDeleted: false }, include: { course: { include: { program: true, semester: true } }, term: true } }));
  res.json({
    offerings: offerings.map((o) => ({
      id: o.id, courseCode: o.course.code, courseTitle: o.course.title, creditHours: o.course.creditHours,
      program: o.course.program ? o.course.program.shortForm || o.course.program.code : null,
      semester: o.course.semester ? o.course.semester.number : null, term: o.term ? o.term.title : null,
      locked: !!o.resultLockedAt, submitted: !!o.resultSubmittedAt,
    })),
  });
}));

router.get('/offerings/:id/gradebook', asyncHandler(async (req, res) => {
  const offering = await ownedOffering(req, req.params.id);
  const gb = await gradebook.buildGradebook(offering);
  res.json({ ...gb, completion: completion(gb), locked: !!offering.resultLockedAt, submitted: !!offering.resultSubmittedAt });
}));

// B2.b — per-course Total Marks for Mid and Final.
router.put('/offerings/:id/exam-totals', asyncHandler(async (req, res) => {
  const offering = await ownedOffering(req, req.params.id);
  assertOfferingOpen(offering);
  const parse = (v, cur) => {
    if (v === undefined) return cur;
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) throw httpError(400, 'Total Marks must be a positive number (max 1000).');
    return n;
  };
  const midTotalMarks = parse(req.body.midTotalMarks, offering.midTotalMarks);
  const finalTotalMarks = parse(req.body.finalTotalMarks, offering.finalTotalMarks);
  // Obtained marks already entered must not exceed the new totals.
  const over = await prisma.courseResult.findFirst({
    where: { offeringId: offering.id, OR: [
      ...(midTotalMarks != null ? [{ midMarks: { gt: midTotalMarks } }] : []),
      ...(finalTotalMarks != null ? [{ finalMarks: { gt: finalTotalMarks } }] : []),
    ] },
  });
  if (over && (midTotalMarks != null || finalTotalMarks != null)) throw httpError(400, 'Some students already have obtained marks above this total. Correct those marks first.');
  await prisma.courseOffering.update({ where: { id: offering.id }, data: { midTotalMarks, finalTotalMarks } });
  await prisma.courseResult.updateMany({
    where: { offeringId: offering.id, workflowStage: 'DRAFT' },
    data: { ...(midTotalMarks != null ? { midMax: midTotalMarks } : {}), ...(finalTotalMarks != null ? { finalMax: finalTotalMarks } : {}) },
  });
  await audit(req, 'EXAM_TOTALS_SET', 'CourseOffering', offering.id, { before: { mid: offering.midTotalMarks, final: offering.finalTotalMarks }, after: { midTotalMarks, finalTotalMarks } });
  await syncAndBroadcast(offering.id);
  res.json({ message: 'Total marks saved', midTotalMarks, finalTotalMarks });
}));

// Edit one gradebook cell (Assignment / Quiz / Lab / Project item, or Mid / Final).
router.put('/offerings/:id/cell', asyncHandler(async (req, res) => {
  const offering = await ownedOffering(req, req.params.id);
  assertOfferingOpen(offering);
  const { kind, itemId, studentId } = req.body || {};
  const raw = req.body.marks;
  if (!studentId) throw httpError(400, 'studentId is required');
  const reg = await prisma.courseRegistration.findFirst({ where: { offeringId: offering.id, studentId } });
  if (!reg) throw httpError(404, 'Student is not registered in this course');
  const existingResult = await prisma.courseResult.findUnique({ where: { offeringId_studentId: { offeringId: offering.id, studentId } } });
  assertEditable(existingResult);
  const clear = raw === null || raw === '';
  const marks = clear ? null : Number(raw);
  if (!clear && (!Number.isFinite(marks) || marks < 0)) throw httpError(400, 'Marks must be a number ≥ 0');
  const graded = { gradedById: req.lmsUser.id, gradedAt: new Date() };

  if (kind === 'mid' || kind === 'final') {
    const total = kind === 'mid' ? offering.midTotalMarks : offering.finalTotalMarks;
    if (total == null) throw httpError(400, `Set the ${kind === 'mid' ? 'Mid' : 'Final'} Total Marks for this course first.`);
    if (!clear && marks > total) throw httpError(400, `Obtained marks cannot exceed the Total Marks (${total}).`);
    const field = kind === 'mid' ? 'midMarks' : 'finalMarks';
    const maxField = kind === 'mid' ? 'midMax' : 'finalMax';
    await prisma.courseResult.upsert({
      where: { offeringId_studentId: { offeringId: offering.id, studentId } },
      update: { [field]: clear ? 0 : marks, [maxField]: total },
      create: { offeringId: offering.id, studentId, status: 'DRAFT', [field]: clear ? 0 : marks, [maxField]: total },
    });
  } else if (kind === 'assignment' || kind === 'project') {
    const a = await prisma.assignment2.findFirst({ where: { id: Number(itemId), offeringId: offering.id, isDeleted: false } });
    if (!a) throw httpError(404, 'Item not found — create it first.');
    if (!clear && marks > a.totalMarks) throw httpError(400, `Marks cannot exceed ${a.totalMarks}`);
    if (clear) await prisma.assignmentSubmission.updateMany({ where: { assignmentId: a.id, studentId }, data: { marks: null, status: 'SUBMITTED' } });
    else await prisma.assignmentSubmission.upsert({ where: { assignmentId_studentId: { assignmentId: a.id, studentId } }, update: { marks, status: 'GRADED', ...graded }, create: { assignmentId: a.id, studentId, marks, status: 'GRADED', content: 'Marks entered by teacher', ...graded } });
  } else if (kind === 'lab') {
    const t = await prisma.labTask.findFirst({ where: { id: Number(itemId), offeringId: offering.id, isDeleted: false } });
    if (!t) throw httpError(404, 'Lab task not found — create it first.');
    if (!clear && marks > t.totalMarks) throw httpError(400, `Marks cannot exceed ${t.totalMarks}`);
    if (clear) await prisma.labTaskSubmission.updateMany({ where: { labTaskId: t.id, studentId }, data: { marks: null, status: 'SUBMITTED' } });
    else await prisma.labTaskSubmission.upsert({ where: { labTaskId_studentId: { labTaskId: t.id, studentId } }, update: { marks, status: 'GRADED', ...graded }, create: { labTaskId: t.id, studentId, marks, status: 'GRADED', content: 'Marks entered by teacher', ...graded } });
  } else if (kind === 'quiz') {
    const q = await prisma.quiz.findFirst({ where: { id: Number(itemId), offeringId: offering.id, isDeleted: false } });
    if (!q) throw httpError(404, 'Quiz not found — create it first.');
    const attempt = await prisma.quizAttempt.findUnique({ where: { quizId_studentId: { quizId: q.id, studentId } } });
    const max = attempt && attempt.maxScore > 0 ? attempt.maxScore : q.totalMarks;
    if (!(max > 0)) throw httpError(400, 'This quiz has no total marks yet — add questions (or set total) first.');
    if (!clear && marks > max) throw httpError(400, `Score cannot exceed ${max}`);
    if (clear) await prisma.quizAttempt.updateMany({ where: { quizId: q.id, studentId }, data: { score: null, status: 'SUBMITTED' } });
    else await prisma.quizAttempt.upsert({ where: { quizId_studentId: { quizId: q.id, studentId } }, update: { score: marks, status: 'GRADED', gradedAt: new Date() }, create: { quizId: q.id, studentId, score: marks, maxScore: max, status: 'GRADED', submittedAt: new Date(), gradedAt: new Date() } });
  } else {
    throw httpError(400, 'Unknown assessment kind');
  }
  await audit(req, 'GRADEBOOK_CELL', 'CourseOffering', offering.id, { after: { kind, itemId, studentId, marks } });
  await syncAndBroadcast(offering.id, [studentId]);
  if (!clear) await notify(studentId, { title: 'Marks updated', message: `New marks were recorded in ${offering.course.code}`, type: 'RESULT', link: '/student/results' });
  const gb = await gradebook.buildGradebook(offering.id, { studentId });
  res.json({ row: gb.rows[0] || null });
}));

// ---------------- A7: Results Submission ----------------
router.get('/submission', asyncHandler(async (req, res) => {
  const offerings = await myTermOfferings(req);
  const items = [];
  for (const o of offerings) {
    const gb = await gradebook.buildGradebook(o);
    items.push({
      id: o.id, courseCode: o.course.code, courseTitle: o.course.title, creditHours: o.course.creditHours,
      program: o.course.program ? o.course.program.shortForm || o.course.program.code : null,
      department: o.course.program ? o.course.program.department : null,
      semester: o.course.semester ? o.course.semester.number : null,
      term: o.term ? o.term.title : null,
      midTotalMarks: o.midTotalMarks, finalTotalMarks: o.finalTotalMarks,
      status: o.resultSubmittedAt ? 'SUBMITTED' : o.resultLockedAt ? 'PUBLISHED' : 'OPEN',
      lockedAt: o.resultLockedAt, submittedAt: o.resultSubmittedAt,
      completion: completion(gb),
    });
  }
  const allPublished = items.length > 0 && items.every((i) => i.status !== 'OPEN');
  const allSubmitted = items.length > 0 && items.every((i) => i.status === 'SUBMITTED');
  res.json({
    subjects: items,
    summary: {
      subjects: items.length,
      published: items.filter((i) => i.status !== 'OPEN').length,
      submitted: items.filter((i) => i.status === 'SUBMITTED').length,
      students: items.reduce((s, i) => s + i.completion.students, 0),
      studentsComplete: items.reduce((s, i) => s + i.completion.studentsComplete, 0),
      readyForFinalSubmission: allPublished && !allSubmitted,
      finalSubmitted: allSubmitted,
    },
  });
}));

// Publish one subject's result → locked for the teacher (PIN re-verified).
router.post('/offerings/:id/publish', asyncHandler(async (req, res) => {
  const offering = await ownedOffering(req, req.params.id);
  if (req.lmsUser.role !== 'Teacher') throw httpError(403, 'Only the course teacher can publish this result.');
  assertOfferingOpen(offering);
  await pin.verifyPin(req.lmsUser.id, (req.body || {}).pin);
  if (offering.midTotalMarks == null || offering.finalTotalMarks == null) {
    const gbw = await gradebook.buildGradebook(offering);
    const needsMid = gbw.categories.some((c) => c.key === 'mid') && offering.midTotalMarks == null;
    const needsFinal = gbw.categories.some((c) => c.key === 'final') && offering.finalTotalMarks == null;
    if (needsMid || needsFinal) throw httpError(400, 'Set the Mid and Final Total Marks for this course before publishing.');
  }
  await gradebook.syncResults(offering);
  const now = new Date();
  const upd = await prisma.courseResult.updateMany({
    where: { offeringId: offering.id, workflowStage: 'DRAFT' },
    data: { workflowStage: 'LOCKED', status: 'LOCKED', lockedAt: now },
  });
  await prisma.courseOffering.update({ where: { id: offering.id }, data: { resultLockedAt: now, resultLockedById: req.lmsUser.id } });
  await audit(req, 'RESULT_SUBJECT_PUBLISH', 'CourseOffering', offering.id, { after: { locked: upd.count } });
  const regs = await prisma.courseRegistration.findMany({ where: { offeringId: offering.id }, select: { studentId: true } });
  realtime.emitTo(regs.map((r) => r.studentId), 'result', { action: 'subject-locked', offeringId: offering.id });
  res.json({ message: `${offering.course.code} result published and locked (${upd.count} student(s)).`, locked: upd.count });
}));

// ---------------- A8: Final submission to Exam Controller ----------------
router.post('/final-submit', asyncHandler(async (req, res) => {
  if (req.lmsUser.role !== 'Teacher') throw httpError(403, 'Only teachers submit results.');
  await pin.verifyPin(req.lmsUser.id, (req.body || {}).pin);
  const offerings = await myTermOfferings(req);
  if (!offerings.length) throw httpError(400, 'You have no subjects this term.');
  const open = offerings.filter((o) => !o.resultLockedAt);
  if (open.length) throw httpError(409, `Publish every subject first. Still open: ${open.map((o) => o.course.code).join(', ')}`);
  const pending = offerings.filter((o) => !o.resultSubmittedAt);
  if (!pending.length) throw httpError(409, 'All results were already submitted to the Exam Controller.');
  const now = new Date();
  const ids = pending.map((o) => o.id);
  await prisma.$transaction([
    prisma.courseResult.updateMany({ where: { offeringId: { in: ids }, workflowStage: 'LOCKED' }, data: { workflowStage: 'SUBMITTED', status: 'FINALIZED', submittedAt: now } }),
    prisma.courseOffering.updateMany({ where: { id: { in: ids } }, data: { resultSubmittedAt: now, resultSubmittedById: req.lmsUser.id } }),
  ]);
  await audit(req, 'RESULT_FINAL_SUBMIT', 'CourseOffering', ids.join(','), { after: { subjects: ids.length } });
  const exams = await prisma.lmsUser.findMany({ where: { role: 'ExamController', isActive: true }, select: { id: true } });
  await notifyMany(exams.map((e) => e.id), { title: 'Results submitted', message: `${req.lmsUser.username} submitted results for ${pending.map((o) => o.course.code).join(', ')}.`, type: 'RESULT', link: '/exam/result-compilation' });
  realtime.emitTo(exams.map((e) => e.id), 'result', { action: 'teacher-submitted', offeringIds: ids });
  res.json({ message: `Submitted ${ids.length} subject result(s) to the Exam Controller. They are now permanently locked.`, submitted: ids.length });
}));

module.exports = router;
