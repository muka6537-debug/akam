// ============================================================
//  EXAM CONTROLLER — RESULT WORKFLOW (A9) + GAZETTE (A11)
//  Mounted at /api/lms/academic/exam/workflow
//  ------------------------------------------------------------
//  Four sequential stages, navigated Department → Program → Semester →
//  Subject (click-through tree, no flat dropdown filtering):
//    compilation  every result submitted by teachers (read-only)
//    collection   SUBMITTED → action: Declare Unofficial Result
//    finalizing   UNOFFICIAL → action: Declare Official Result
//    archive      OFFICIAL, read-only forever
//  Excel + PDF export on every stage and on the Gazette.
//  Marks are never editable here (DB triggers also enforce this).
// ============================================================
const express = require('express');
const prisma = require('../../../utils/prisma');
const { lmsAuth, lmsRequireRole } = require('../../../middleware/lmsAuth');
const { asyncHandler, httpError } = require('../../../utils/lmsHelpers');
const { audit } = require('../../../utils/lmsAudit');
const { notifyMany } = require('../../../utils/lmsNotify');
const realtime = require('../../../utils/lmsRealtime');
const svc = require('../../../services/resultsService');
const X = require('../../../services/resultExports');

const router = express.Router();
router.use(lmsAuth);
const EXAM = lmsRequireRole('ExamController');
const EXAM_OR_GOV = lmsRequireRole('ExamController', 'Provost');

const STAGE_META = {
  compilation: { title: 'Result Compilation', action: null },
  collection: { title: 'Results Collection (Unofficial)', action: 'Declare Unofficial Result' },
  finalizing: { title: 'Result Finalizing & Official Declaration', action: 'Declare Official Result' },
  archive: { title: 'Results Archive (Official, read-only)', action: null },
};

function stageParam(req) {
  const s = String(req.params.stage || '');
  if (!svc.STAGE_SETS[s]) throw httpError(404, 'Unknown result stage');
  return s;
}
function scopeOf(q) {
  return {
    department: q.department || undefined,
    program: q.program || undefined,
    semester: q.semester || undefined,
    offeringId: q.offeringId || undefined,
  };
}
function scopeLabel(s) {
  return [s.department, s.program, s.semester ? `Semester ${s.semester}` : null].filter(Boolean).join(' › ') || 'All Departments';
}

// Counts for every stage (sidebar badges / overview cards).
router.get('/summary', EXAM_OR_GOV, asyncHandler(async (req, res) => {
  const grouped = await prisma.courseResult.groupBy({ by: ['workflowStage'], _count: { _all: true } });
  const c = Object.fromEntries(grouped.map((g) => [g.workflowStage, g._count._all]));
  const term = await svc.currentTerm();
  // Teacher submission progress for the current term.
  const offerings = await prisma.courseOffering.findMany({ where: { isDeleted: false, ...(term ? { termId: term.id } : {}) }, select: { resultLockedAt: true, resultSubmittedAt: true } });
  res.json({
    currentSession: term?.title || null,
    stages: {
      compilation: (c.SUBMITTED || 0) + (c.UNOFFICIAL || 0) + (c.OFFICIAL || 0),
      collection: c.SUBMITTED || 0,
      finalizing: c.UNOFFICIAL || 0,
      archive: c.OFFICIAL || 0,
    },
    teacherProgress: {
      subjects: offerings.length,
      published: offerings.filter((o) => o.resultLockedAt).length,
      submitted: offerings.filter((o) => o.resultSubmittedAt).length,
    },
    draftWithTeachers: (c.DRAFT || 0) + (c.LOCKED || 0),
  });
}));

// ---------------- Gazette (A11) ----------------
router.get('/gazette/batches', EXAM_OR_GOV, asyncHandler(async (req, res) => {
  res.json({ batches: await svc.gazetteBatches() });
}));
router.get('/gazette', EXAM_OR_GOV, asyncHandler(async (req, res) => {
  if (!req.query.batch) throw httpError(400, 'batch is required');
  res.json(await svc.gazette(String(req.query.batch), { program: req.query.program || undefined }));
}));
router.get('/gazette/export/:format', EXAM_OR_GOV, asyncHandler(async (req, res) => {
  if (!req.query.batch) throw httpError(400, 'batch is required');
  const g = await svc.gazette(String(req.query.batch), { program: req.query.program || undefined });
  const title = `Result Gazette — Batch: ${g.batch}`;
  const subtitle = `Current Session: ${g.currentSession || '—'} · ${g.students.length} student(s)${req.query.program ? ` · ${req.query.program}` : ''}`;
  const sections = X.gazetteSections(g);
  await audit(req, 'EXAM_GAZETTE_EXPORT', 'Gazette', g.batch, { after: { format: req.params.format } });
  if (req.params.format === 'excel') return X.excel(res, `gazette-${g.batch}`, title, subtitle, sections);
  if (req.params.format === 'pdf') return X.pdf(res, `gazette-${g.batch}`, title, subtitle, sections);
  throw httpError(400, 'format must be excel or pdf');
}));

// Department → Program → Semester → Subject tree for a stage.
router.get('/:stage/tree', EXAM_OR_GOV, asyncHandler(async (req, res) => {
  const stage = stageParam(req);
  const rows = await svc.fetchResults(svc.STAGE_SETS[stage]);
  res.json({ stage, ...STAGE_META[stage], total: rows.length, tree: svc.buildTree(rows) });
}));

// Subject-level sheet: all enrolled students with marks, GP, GPA.
router.get('/:stage/subject/:offeringId', EXAM_OR_GOV, asyncHandler(async (req, res) => {
  const stage = stageParam(req);
  const rows = await svc.subjectSheet(stage, req.params.offeringId);
  const off = await prisma.courseOffering.findUnique({ where: { id: Number(req.params.offeringId) }, include: { course: { include: { program: true, semester: true } }, term: true, teacher: { include: { profile: true } } } });
  if (!off) throw httpError(404, 'Subject not found');
  res.json({
    stage,
    subject: {
      offeringId: off.id, courseCode: off.course.code, courseTitle: off.course.title, creditHours: off.course.creditHours,
      department: off.course.program?.department || null, program: off.course.program?.shortForm || off.course.program?.code || null,
      semester: off.course.semester?.number || null, term: off.term?.title || null,
      teacher: off.teacher?.profile?.fullName || off.teacher?.username || null,
      midTotalMarks: off.midTotalMarks, finalTotalMarks: off.finalTotalMarks,
      submittedAt: off.resultSubmittedAt,
    },
    students: rows,
  });
}));

// Student-wise summary for a Department/Program/Semester scope.
router.get('/:stage/students', EXAM_OR_GOV, asyncHandler(async (req, res) => {
  const stage = stageParam(req);
  const scope = scopeOf(req.query);
  res.json({ stage, scope, students: await svc.scopeStudents(stage, scope) });
}));

// Declarations (scope must be Department + Program + Semester).
async function doDeclare(req, res, kind) {
  const scope = scopeOf(req.body || {});
  if (!scope.department || !scope.program || !scope.semester) throw httpError(400, 'Select Department, Program and Semester to declare results.');
  if (!(req.body && req.body.confirm === true)) throw httpError(400, 'Confirmation is required to declare results.');
  const out = await svc.declare(kind, scope, req.lmsUser.id);
  await audit(req, kind === 'unofficial' ? 'EXAM_DECLARE_UNOFFICIAL' : 'EXAM_DECLARE_OFFICIAL', 'CourseOffering', out.offeringIds.join(','), { after: { scope, declared: out.declared } });
  const semLabel = `Semester ${scope.semester}`;
  await notifyMany(out.studentIds, kind === 'unofficial'
    ? { title: 'Unofficial result declared', message: `Your ${semLabel} unofficial result, GPA, CGPA and transcript are now available.`, type: 'SUCCESS', link: '/student/results' }
    : { title: 'Official result declared', message: `Your ${semLabel} result is now official. The official transcript is available.`, type: 'SUCCESS', link: '/student/results' });
  realtime.emitTo(out.studentIds, 'result', { action: `declared-${kind}`, semester: scope.semester });
  res.json({ success: true, ...out, message: `${out.declared} result(s) declared ${kind} for ${scopeLabel(scope)}.` });
}
router.post('/collection/declare-unofficial', EXAM, asyncHandler((req, res) => doDeclare(req, res, 'unofficial')));
router.post('/finalizing/declare-official', EXAM, asyncHandler((req, res) => doDeclare(req, res, 'official')));

// ---------------- Exports (every stage) ----------------
router.get('/:stage/export/:format', EXAM_OR_GOV, asyncHandler(async (req, res) => {
  const stage = stageParam(req);
  const format = req.params.format;
  if (!['excel', 'pdf'].includes(format)) throw httpError(400, 'format must be excel or pdf');
  const scope = scopeOf(req.query);
  const base = await svc.fetchResults(svc.STAGE_SETS[stage], scope);
  const idx = await svc.gpaIndex([...new Set(base.map((r) => r.studentId))], svc.STAGE_SETS.compilation);
  const rows = base.map((r) => ({ ...r, semesterGpa: idx[r.studentId]?.[r.semester || 0]?.gpa, cgpa: idx[r.studentId]?.[r.semester || 0]?.cgpa }));
  const sections = X.scopeSections(rows);
  const title = STAGE_META[stage].title;
  const subtitle = `${scopeLabel(scope)} · ${rows.length} result(s)`;
  const name = `${stage}-${scopeLabel(scope)}`;
  await audit(req, 'EXAM_WORKFLOW_EXPORT', 'Stage', stage, { after: { format, scope } });
  if (format === 'excel') return X.excel(res, name, title, subtitle, sections);
  return X.pdf(res, name, title, subtitle, sections, { landscape: true });
}));

module.exports = router;
