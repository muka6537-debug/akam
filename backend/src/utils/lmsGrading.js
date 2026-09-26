// ============================================================
//  LMS GRADING SERVICE — OFFICIAL AUST SCALE (single source of truth)
//  ------------------------------------------------------------
//  Implements AUST Academic Rules §19.8 (grading & grade points),
//  §19.10 (annual-system → GPA/CGPA conversion, separate path) and
//  §20.2 (probation). EVERY part of the LMS (gradebook, marks, CGPA
//  calculator, result compilation, gazette, transcripts) must use the
//  helpers exported here — no divergent / simplified scale anywhere.
//
//  Grade points are PER-PERCENT between 50 and 79 (e.g. 65% → 2.5,
//  72% → 3.2) and 4.00 from 80% upward. Percentages are rounded to the
//  nearest whole mark before lookup (a 64.5% total counts as 65%).
// ============================================================

const PASS_PERCENT = 50;
// Level-specific fail thresholds (§19.8: F = 0-49 UG, 0-59 MPhil, 0-64 PhD).
const FAIL_BELOW = { UG: 50, MS: 50, MPHIL: 60, PHD: 65 };
// Minimum CGPA for degree completion & probation GPA thresholds.
const MIN_CGPA = { UG: 2.0, MS: 2.5, MPHIL: 2.5, PHD: 2.5 };

/**
 * Official AUST table (for display / docs). `min`/`max` are whole-percent
 * bounds; `points` is the grade point for that band.
 */
const GRADE_TABLE = [
  { grade: 'A', min: 90, max: 100, points: 4.0, remarks: 'Excellent' },
  { grade: 'A', min: 85, max: 89, points: 4.0, remarks: 'Very Good' },
  { grade: 'A-', min: 80, max: 84, points: 4.0, remarks: 'Very Good' },
  ...[79, 78, 77, 76, 75, 74, 73].map((p) => ({ grade: 'B', min: p, max: p, points: +(p / 10 - 4).toFixed(1), remarks: 'Good' })),
  ...[72, 71, 70].map((p) => ({ grade: 'B-', min: p, max: p, points: +(p / 10 - 4).toFixed(1), remarks: 'Good' })),
  ...[69, 68, 67, 66, 65, 64, 63].map((p) => ({ grade: 'C', min: p, max: p, points: +(p / 10 - 4).toFixed(1), remarks: 'Satisfactory' })),
  ...[62, 61, 60].map((p) => ({ grade: 'C-', min: p, max: p, points: +(p / 10 - 4).toFixed(1), remarks: 'Satisfactory' })),
  ...[59, 58, 57, 56, 55, 54, 53, 52, 51, 50].map((p) => ({ grade: 'D', min: p, max: p, points: +(p / 10 - 4).toFixed(1), remarks: 'Pass' })),
  { grade: 'F', min: 0, max: 49, points: 0, remarks: 'Fail' },
];
const SPECIAL_GRADES = [
  { grade: 'F', label: '0–59 (MPhil)', points: 0, remarks: 'Fail' },
  { grade: 'F', label: '0–64 (PhD)', points: 0, remarks: 'Fail' },
  { grade: 'W', label: 'Withdrawn course', points: null, remarks: 'Withdrawn' },
  { grade: 'I', label: 'Incomplete course', points: null, remarks: 'Incomplete' },
];
// Back-compat export: legacy consumers read GRADE_SCALE as [{min,letter,points}] high→low.
const GRADE_SCALE = GRADE_TABLE.map((g) => ({ min: g.min, letter: g.grade, points: g.points }));

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function normLevel(level) {
  const l = String(level || 'UG').toUpperCase().replace(/[^A-Z]/g, '');
  if (l.startsWith('PHD')) return 'PHD';
  if (l.startsWith('MPHIL')) return 'MPHIL';
  if (l === 'MS' || l.startsWith('MS')) return 'MS';
  return 'UG';
}

/** Program level from a program name/code (BS/ADCS/BBA → UG, MS, MPhil, PhD). */
function levelFromProgram(nameOrCode) {
  const s = String(nameOrCode || '').toUpperCase();
  if (/\bPH\.?D\b/.test(s)) return 'PHD';
  if (/M\.?\s?PHIL/.test(s)) return 'MPHIL';
  if (/^MS\b|\bMS\s|MASTER/.test(s)) return 'MS';
  return 'UG';
}

/**
 * Map a percentage (0..100) to the official AUST grade.
 * @returns {{letter:string, points:number, remarks:string, percent:number}}
 */
function gradeFromPercent(percent, level = 'UG') {
  const raw = Math.max(0, Math.min(100, Number(percent) || 0));
  const p = Math.round(raw);
  const lvl = normLevel(level);
  if (p < FAIL_BELOW[lvl]) return { letter: 'F', points: 0, remarks: 'Fail', percent: raw };
  const hit = GRADE_TABLE.find((g) => p >= g.min && p <= g.max) || GRADE_TABLE[GRADE_TABLE.length - 1];
  return { letter: hit.grade, points: hit.points, remarks: hit.remarks, percent: raw };
}

/** Weighted conversion: obtained/total scaled onto a weight (e.g. 25/50 @5% → 2.5). */
function convertToWeight(obtained, total, weight) {
  if (obtained == null || obtained === '' || total == null || Number(total) <= 0) return null;
  const cap = Number(weight) || 0;
  return round2(Math.min(Math.max((Number(obtained) / Number(total)) * cap, 0), cap));
}

/**
 * Weighted total percentage for a CourseResult-like row. Each component
 * contributes (marks / max) * weight.
 */
function computeWeightedPercent(r, w) {
  const part = (marks, max, weight) => {
    const m = Number(max) || 0;
    if (m <= 0) return 0;
    return Math.min(1, Math.max(0, (Number(marks) || 0) / m)) * (Number(weight) || 0);
  };
  const total =
    part(r.assignmentMarks, r.assignmentMax, w.assignmentWeight) +
    part(r.quizMarks, r.quizMax, w.quizWeight) +
    part(r.midMarks, r.midMax, w.midWeight) +
    part(r.finalMarks, r.finalMax, w.finalWeight) +
    part(r.labMarks, r.labMax, w.labWeight) +
    part(r.projectMarks, r.projectMax, w.projectWeight);
  return round2(total);
}

function buildResultGrades(componentMarks, offeringWeights, level = 'UG') {
  const totalPercent = computeWeightedPercent(componentMarks, offeringWeights || {});
  const { letter, points } = gradeFromPercent(totalPercent, level);
  return { totalPercent, letterGrade: letter, gradePoints: points };
}

/**
 * GPA / CGPA = Σ(credit hours × grade point) / Σ credit hours.
 * Withdrawn (W) / Incomplete (I) courses are excluded from both sums.
 */
function computeGPA(results) {
  let totalPoints = 0;
  let totalCredits = 0;
  for (const r of results || []) {
    const g = String(r.letterGrade || r.grade || '').toUpperCase();
    if (g === 'W' || g === 'I') continue;
    const ch = Number(r.creditHours) || 0;
    totalPoints += (Number(r.gradePoints) || 0) * ch;
    totalCredits += ch;
  }
  if (totalCredits === 0) return 0;
  return round2(totalPoints / totalCredits);
}

/** Probation status for a semester GPA (§20.2). */
function probationStatus(gpa, level = 'UG', previousProbations = 0) {
  const min = MIN_CGPA[normLevel(level)];
  if (Number(gpa) >= min) return { onProbation: false, label: 'Good Standing', threshold: min };
  const n = previousProbations + 1;
  return { onProbation: true, label: n >= 2 ? 'Last Probation' : '1st Probation', threshold: min };
}

/** Degree-completion eligibility by CGPA. */
function meetsDegreeCgpa(cgpa, level = 'UG') {
  return Number(cgpa) >= MIN_CGPA[normLevel(level)];
}

// ------------------------------------------------------------
// §19.10 — ANNUAL-SYSTEM → GPA conversion (separate path; ONLY for
// students who studied under the annual system). Never mixed with the
// semester scale above. Ranges map linearly onto the published GP band.
// ------------------------------------------------------------
const ANNUAL_CONVERSION_TABLE = [
  { min: 80, max: 100, gpFrom: 4.0, gpTo: 4.0, label: '80 & above' },
  { min: 75, max: 79, gpFrom: 3.5, gpTo: 3.9, label: '75–79' },
  { min: 73, max: 74, gpFrom: 3.3, gpTo: 3.4, label: '73–74' },
  { min: 70, max: 72, gpFrom: 3.0, gpTo: 3.2, label: '70–72' },
  { min: 66, max: 69, gpFrom: 2.6, gpTo: 2.9, label: '66–69' },
  { min: 63, max: 65, gpFrom: 2.3, gpTo: 2.5, label: '63–65' },
  { min: 60, max: 62, gpFrom: 2.0, gpTo: 2.2, label: '60–62' },
  { min: 50, max: 59, gpFrom: 1.0, gpTo: 1.9, label: '50–59' },
  { min: 0, max: 49, gpFrom: 0, gpTo: 0, label: '0–49' },
];
function annualPercentToGpa(percent) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const band = ANNUAL_CONVERSION_TABLE.find((b) => p >= b.min && p <= b.max);
  if (!band) return 0;
  if (band.max === band.min || band.gpFrom === band.gpTo) return band.gpFrom;
  const span = band.max - band.min;
  return round2(band.gpFrom + ((p - band.min) / span) * (band.gpTo - band.gpFrom));
}

// ============================================================
// resolveOfferingWeights — SINGLE SOURCE OF TRUTH for assessment weightage.
// The Course Coordinator configures CourseWeightage per course (counts +
// weights for Assignment / Quiz / Lab / Project / Mid / Final). Components
// with weight 0 (e.g. no Lab, no Project) are omitted everywhere.
// ============================================================
const COMPONENT_DEFS = [
  { key: 'assignment', label: 'Assignment', weightKey: 'assignmentWeight', marksField: 'assignmentMarks', maxField: 'assignmentMax' },
  { key: 'quiz', label: 'Quiz', weightKey: 'quizWeight', marksField: 'quizMarks', maxField: 'quizMax' },
  { key: 'lab', label: 'Lab', weightKey: 'labWeight', marksField: 'labMarks', maxField: 'labMax' },
  { key: 'project', label: 'Project', weightKey: 'projectWeight', marksField: 'projectMarks', maxField: 'projectMax' },
  { key: 'mid', label: 'Mid', weightKey: 'midWeight', marksField: 'midMarks', maxField: 'midMax' },
  { key: 'final', label: 'Final', weightKey: 'finalWeight', marksField: 'finalMarks', maxField: 'finalMax' },
];

async function resolveOfferingWeights(prisma, offering) {
  let cw = null;
  let course = offering && offering.course;
  try {
    if (offering && offering.courseId) {
      cw = await prisma.courseWeightage.findUnique({ where: { courseId: offering.courseId } });
      if (!course) course = await prisma.lmsCourse.findUnique({ where: { id: offering.courseId } });
    }
  } catch (_) { cw = null; }
  const hasLab = !!(course && course.hasLab);

  const weights = cw
    ? {
        assignmentWeight: Number(cw.assignmentWeight) || 0,
        quizWeight: Number(cw.quizWeight) || 0,
        midWeight: Number(cw.midWeight) || 0,
        finalWeight: Number(cw.finalWeight) || 0,
        labWeight: hasLab ? Number(cw.labTaskWeight) || 0 : 0,
        projectWeight: Number(cw.semesterProjectWeight) || 0,
      }
    : {
        assignmentWeight: Number(offering.assignmentWeight) || 0,
        quizWeight: Number(offering.quizWeight) || 0,
        midWeight: Number(offering.midWeight) || 0,
        finalWeight: Number(offering.finalWeight) || 0,
        labWeight: 0,
        projectWeight: 0,
      };
  const counts = {
    assignment: cw ? Number(cw.assignmentCount) || 0 : 0,
    quiz: cw ? Number(cw.quizCount) || 0 : 0,
    lab: cw && hasLab ? Number(cw.labTaskCount) || 0 : 0,
    project: cw && Number(cw.semesterProjectWeight) > 0 ? 1 : 0,
  };

  const components = COMPONENT_DEFS
    .filter((d) => (weights[d.weightKey] || 0) > 0)
    .map((d) => ({ key: d.key, label: d.label, weight: weights[d.weightKey] || 0, marksField: d.marksField, maxField: d.maxField, count: counts[d.key] }));

  return { weights, components, counts, configured: !!cw, source: cw ? 'coordinator' : 'offering' };
}

module.exports = {
  GRADE_TABLE,
  GRADE_SCALE,
  SPECIAL_GRADES,
  PASS_PERCENT,
  FAIL_BELOW,
  MIN_CGPA,
  ANNUAL_CONVERSION_TABLE,
  gradeFromPercent,
  convertToWeight,
  computeWeightedPercent,
  buildResultGrades,
  computeGPA,
  probationStatus,
  meetsDegreeCgpa,
  annualPercentToGpa,
  levelFromProgram,
  resolveOfferingWeights,
  COMPONENT_DEFS,
  round2,
};
