// ============================================================
//  RESULT WORKFLOW — stages, guards and DB-level immutability
//  ------------------------------------------------------------
//  Stage order (one-way):
//    DRAFT → LOCKED → SUBMITTED → UNOFFICIAL → OFFICIAL
//
//  • DRAFT       teacher editing; students see raw marks only.
//  • LOCKED      teacher published the subject (PIN). Teacher can no
//                longer edit.
//  • SUBMITTED   teacher final-submitted to the Exam Controller.
//                From here on marks are PERMANENTLY immutable for
//                every role (Teacher, Exam Controller, Super Admin…).
//  • UNOFFICIAL  Exam Controller declared the unofficial result →
//                GPA / CGPA / unofficial transcript visible.
//  • OFFICIAL    Exam Controller declared the official result →
//                Results Archive (read-only forever).
//
//  Immutability is enforced in TWO layers:
//   1. Application guards (assertEditable) → friendly 409 errors.
//   2. SQLite triggers installed at startup → ANY UPDATE that
//      changes a mark / grade on a SUBMITTED+ row, or any DELETE of
//      such a row, is aborted by the database itself. Only forward
//      stage transitions are permitted.
// ============================================================
const prisma = require('./prisma');

const STAGES = ['DRAFT', 'LOCKED', 'SUBMITTED', 'UNOFFICIAL', 'OFFICIAL'];
const TEACHER_EDITABLE = ['DRAFT'];
const IMMUTABLE = ['SUBMITTED', 'UNOFFICIAL', 'OFFICIAL'];
const STUDENT_GRADE_VISIBLE = ['UNOFFICIAL', 'OFFICIAL'];

const stageIndex = (s) => STAGES.indexOf(s || 'DRAFT');
const isImmutable = (stage) => IMMUTABLE.includes(stage || 'DRAFT');

function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  e.expose = true;
  return e;
}

/** Throw 409 unless a result row is still teacher-editable. */
function assertEditable(result) {
  if (!result) return;
  const st = result.workflowStage || 'DRAFT';
  if (TEACHER_EDITABLE.includes(st) && !['FINALIZED', 'LOCKED', 'FROZEN'].includes(result.status)) return;
  if (isImmutable(st)) throw httpErr(409, 'This result has been submitted to the Exam Controller and is permanently locked. No role can edit it.');
  throw httpErr(409, 'This subject result has been published/locked by the teacher and can no longer be edited.');
}

// Columns whose change is forbidden once a row is SUBMITTED or later.
const LOCKED_COLUMNS = [
  'assignmentMarks', 'quizMarks', 'midMarks', 'finalMarks', 'labMarks', 'projectMarks',
  'assignmentMax', 'quizMax', 'midMax', 'finalMax', 'labMax', 'projectMax',
  'totalPercent', 'letterGrade', 'gradePoints', 'studentId', 'offeringId',
];

/**
 * Install SQLite triggers that make SUBMITTED / UNOFFICIAL / OFFICIAL results
 * immutable at the database layer, and forbid moving a stage backwards.
 * Idempotent (DROP + CREATE). Safe to call at every boot.
 */
async function installResultLockTriggers(client = prisma) {
  const imm = IMMUTABLE.map((s) => `'${s}'`).join(',');
  const changed = LOCKED_COLUMNS
    .map((c) => `(OLD."${c}" IS NOT NEW."${c}")`)
    .join(' OR ');
  const rank = (col) => `(CASE ${col} ${STAGES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE 0 END)`;
  const stmts = [
    'DROP TRIGGER IF EXISTS trg_course_result_immutable_update',
    'DROP TRIGGER IF EXISTS trg_course_result_immutable_delete',
    'DROP TRIGGER IF EXISTS trg_course_result_stage_forward',
    `CREATE TRIGGER trg_course_result_immutable_update
       BEFORE UPDATE ON "CourseResult"
       WHEN OLD."workflowStage" IN (${imm}) AND (${changed})
       BEGIN SELECT RAISE(ABORT, 'RESULT_IMMUTABLE: submitted/declared results cannot be edited'); END`,
    `CREATE TRIGGER trg_course_result_immutable_delete
       BEFORE DELETE ON "CourseResult"
       WHEN OLD."workflowStage" IN (${imm})
       BEGIN SELECT RAISE(ABORT, 'RESULT_IMMUTABLE: submitted/declared results cannot be deleted'); END`,
    `CREATE TRIGGER trg_course_result_stage_forward
       BEFORE UPDATE OF "workflowStage" ON "CourseResult"
       WHEN ${rank('NEW."workflowStage"')} < ${rank('OLD."workflowStage"')}
       BEGIN SELECT RAISE(ABORT, 'RESULT_IMMUTABLE: result workflow stage cannot move backwards'); END`,
  ];
  for (const sql of stmts) await client.$executeRawUnsafe(sql);
  return true;
}

/** Translate a trigger abort into a clean 409 for API callers. */
function mapImmutableError(err) {
  if (err && /RESULT_IMMUTABLE/.test(String(err.message || ''))) {
    return httpErr(409, 'This result is permanently locked (submitted to / declared by the Exam Controller). No role can edit it.');
  }
  return err;
}

module.exports = {
  STAGES,
  TEACHER_EDITABLE,
  IMMUTABLE,
  STUDENT_GRADE_VISIBLE,
  stageIndex,
  isImmutable,
  assertEditable,
  installResultLockTriggers,
  mapImmutableError,
};
