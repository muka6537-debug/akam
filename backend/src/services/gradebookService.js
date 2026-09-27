// ============================================================
//  GRADEBOOK SERVICE — single computation used by Teacher, Student
//  and Exam Controller views (Part A: A1/A2/A3/A5/B2.b).
//  ------------------------------------------------------------
//  • Components come ONLY from the Course Coordinator's CourseWeightage
//    (Assignment / Quiz / Lab / Project / Mid / Final). Weight 0 → the
//    component does not exist for that subject anywhere.
//  • Per-item conversion (A3): the teacher enters an item out of ANY
//    total (e.g. 25/50); it is converted onto that item's share of the
//    category weight: (obtained / total) × itemWeight → 2.5 of 5.
//  • Mid/Final keep the existing obtained-marks entry; their Total Marks
//    come from the per-course midTotalMarks / finalTotalMarks (B2.b).
//  • syncResults() persists the aggregate into CourseResult so every
//    downstream consumer (results, compilation, gazette, transcripts)
//    reads exactly the same numbers. Only DRAFT rows are ever touched.
// ============================================================
const prisma = require('../utils/prisma');
const {
  resolveOfferingWeights, gradeFromPercent, convertToWeight, levelFromProgram, round2,
} = require('../utils/lmsGrading');

function safeItems(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Split a category weight across n items (coordinator per-item weights win). */
function itemWeights(categoryWeight, count, configuredItems) {
  const n = Math.max(0, count);
  if (!n) return [];
  const cfg = safeItems(configuredItems);
  const cfgSum = cfg.slice(0, n).reduce((s, it) => s + (Number(it && it.weight) || 0), 0);
  if (cfg.length >= n && Math.abs(cfgSum - categoryWeight) < 0.05) {
    return cfg.slice(0, n).map((it) => Number(it.weight) || 0);
  }
  return Array.from({ length: n }, () => categoryWeight / n);
}

async function loadOffering(offeringOrId) {
  if (offeringOrId && typeof offeringOrId === 'object' && offeringOrId.course) return offeringOrId;
  const id = typeof offeringOrId === 'object' ? offeringOrId.id : offeringOrId;
  return prisma.courseOffering.findUnique({
    where: { id: Number(id) },
    include: { course: { include: { program: true, semester: true } }, term: true },
  });
}

/**
 * Build the full gradebook for an offering.
 * @param {object|number} offeringOrId
 * @param {{studentId?:string}} opts restrict to one student (student view)
 */
async function buildGradebook(offeringOrId, opts = {}) {
  const offering = await loadOffering(offeringOrId);
  if (!offering) return null;
  const offeringId = offering.id;
  const { weights, counts, configured } = await resolveOfferingWeights(prisma, offering);
  const cw = await prisma.courseWeightage.findUnique({ where: { courseId: offering.courseId } }).catch(() => null);
  const level = levelFromProgram(offering.course?.program?.name || offering.course?.program?.code);

  const regWhere = { offeringId, status: { in: ['ENROLLED', 'COMPLETED'] } };
  if (opts.studentId) regWhere.studentId = opts.studentId;
  const subWhere = opts.studentId ? { where: { studentId: opts.studentId } } : true;
  const [regs, assignmentsAll, quizzes, labTasks, results] = await Promise.all([
    prisma.courseRegistration.findMany({ where: regWhere, include: { student: { include: { profile: true } } }, orderBy: { registeredAt: 'asc' } }),
    prisma.assignment2.findMany({ where: { offeringId, isDeleted: false }, include: { submissions: subWhere }, orderBy: { id: 'asc' } }),
    prisma.quiz.findMany({ where: { offeringId, isDeleted: false }, include: { attempts: subWhere }, orderBy: { id: 'asc' } }),
    prisma.labTask.findMany({ where: { offeringId, isDeleted: false }, include: { submissions: subWhere }, orderBy: { id: 'asc' } }),
    prisma.courseResult.findMany({ where: { offeringId, ...(opts.studentId ? { studentId: opts.studentId } : {}) } }),
  ]);
  const assignments = assignmentsAll.filter((a) => (a.kind || 'ASSIGNMENT') !== 'PROJECT');
  const projects = assignmentsAll.filter((a) => a.kind === 'PROJECT');
  const resultMap = Object.fromEntries(results.map((r) => [r.studentId, r]));

  // ---- Column plan (A5: exactly the coordinator's categories) ----
  const categories = [];
  const LEGACY = { assignment: ['assignmentMarks', 'assignmentMax'], quiz: ['quizMarks', 'quizMax'], lab: ['labMarks', 'labMax'] };
  const plan = (key, label, weight, limit, actual, cfgItems, getCell) => {
    if (!(weight > 0)) return;
    // Slots = coordinator count (hard limit). Legacy data (no config) → actual items.
    const slots = configured && limit > 0 ? limit : Math.max(actual.length, 1);
    const shares = itemWeights(weight, slots, cfgItems);
    const fallback = !configured && actual.length === 0 && LEGACY[key] ? legacyAggregate(key, ...LEGACY[key]) : null;
    const items = shares.map((w, i) => {
      const a = actual[i] || null;
      if (!a && fallback && i === 0) {
        return { key: `${key}-legacy`, kind: key, id: null, label, itemWeight: round2(w), totalMarks: null, created: true, legacy: true, getCell: fallback };
      }
      return {
        key: a ? `${key}-${a.id}` : `${key}-slot-${i + 1}`,
        kind: key, id: a ? a.id : null,
        label: a ? a.title : `${label} ${i + 1}`,
        itemWeight: round2(w),
        totalMarks: a ? Number(a.totalMarks) || 0 : null,
        created: !!a,
        getCell: a ? (sid) => getCell(a, sid) : () => null,
      };
    });
    categories.push({ key, label, weight: round2(weight), limit: configured ? limit : null, created: Math.min(actual.length, slots), items });
  };
  const subOf = (list, sid) => (list || []).find((s) => s.studentId === sid && s.marks != null);
  // Legacy compatibility: when a category has NO actual items yet but the
  // stored result carries an aggregate for it (older data entered directly
  // as Assignment/Quiz/Lab marks), expose that aggregate as the single slot.
  const legacyAggregate = (key, marksField, maxField) => (sid) => {
    const r = resultMap[sid];
    if (!r || !(Number(r[marksField]) > 0) || !(Number(r[maxField]) > 0)) return null;
    return { obtained: Number(r[marksField]), total: Number(r[maxField]) };
  };
  plan('assignment', 'Assignment', weights.assignmentWeight, counts.assignment, assignments, cw && cw.assignmentItems,
    (a, sid) => { const s = subOf(a.submissions, sid); return s ? { obtained: Number(s.marks), total: Number(a.totalMarks) } : null; });
  plan('quiz', 'Quiz', weights.quizWeight, counts.quiz, quizzes, cw && cw.quizItems,
    (q, sid) => {
      const t = (q.attempts || []).find((x) => x.studentId === sid && x.score != null);
      if (!t) return null;
      const total = Number(t.maxScore) > 0 ? Number(t.maxScore) : Number(q.totalMarks);
      return { obtained: Number(t.score), total };
    });
  plan('lab', 'Lab', weights.labWeight, counts.lab, labTasks, cw && cw.labTaskItems,
    (t, sid) => { const s = subOf(t.submissions, sid); return s ? { obtained: Number(s.marks), total: Number(t.totalMarks) } : null; });
  plan('project', 'Project', weights.projectWeight, counts.project || 1, projects, null,
    (a, sid) => { const s = subOf(a.submissions, sid); return s ? { obtained: Number(s.marks), total: Number(a.totalMarks) } : null; });

  const midTotal = offering.midTotalMarks != null ? Number(offering.midTotalMarks) : null;
  const finalTotal = offering.finalTotalMarks != null ? Number(offering.finalTotalMarks) : null;
  const exam = (key, label, weight, totalConfigured, marksField, maxField) => {
    if (!(weight > 0)) return;
    categories.push({
      key, label, weight: round2(weight), limit: 1, created: 1, exam: true, totalMarks: totalConfigured,
      items: [{ key, kind: key, id: null, label, itemWeight: round2(weight), totalMarks: totalConfigured, created: true, editable: true, marksField, maxField,
        getCell: (sid) => {
          const r = resultMap[sid];
          if (!r) return null;
          const obtained = r[marksField];
          // Existing convention: an unentered Mid/Final on a DRAFT row is 0, so
          // 0 is shown as Pending until the result leaves DRAFT.
          const hasValue = obtained != null && (Number(obtained) > 0 || (r.workflowStage || 'DRAFT') !== 'DRAFT');
          if (!hasValue) return null;
          const total = totalConfigured != null ? totalConfigured : Number(r[maxField]) || 100;
          return { obtained: Number(obtained), total };
        } }],
    });
  };
  exam('mid', 'Mid', weights.midWeight, midTotal, 'midMarks', 'midMax');
  exam('final', 'Final', weights.finalWeight, finalTotal, 'finalMarks', 'finalMax');

  // ---- Rows ----
  const rows = regs.map((reg) => {
    const sid = reg.studentId;
    const existing = resultMap[sid] || null;
    const cells = {};
    const comp = {}; // category key → { obtainedW, weight, gradedWeight }
    for (const cat of categories) {
      let sumW = 0; let graded = 0;
      for (const it of cat.items) {
        const raw = it.getCell(sid);
        const converted = raw ? convertToWeight(raw.obtained, raw.total, it.itemWeight) : null;
        cells[it.key] = {
          obtained: raw ? raw.obtained : null,
          total: raw ? raw.total : it.totalMarks,
          converted,
          weight: it.itemWeight,
          pending: raw == null,
        };
        if (converted != null) { sumW += converted; graded += 1; }
      }
      comp[cat.key] = { obtained: round2(sumW), weight: cat.weight, graded };
    }
    const weightedTotal = round2(Object.values(comp).reduce((s, c) => s + c.obtained, 0));
    const totalWeight = round2(categories.reduce((s, c) => s + c.weight, 0));
    const percent = totalWeight > 0 ? round2((weightedTotal / totalWeight) * 100) : 0;
    const grade = gradeFromPercent(percent, level);
    const p = reg.student.profile || {};
    return {
      studentId: sid,
      name: p.fullName || reg.student.username,
      rollNumber: reg.student.linkedRollNumber || reg.student.username,
      registrationNumber: p.registrationNumber || null,
      batch: p.session || null,
      cells,
      components: comp,
      weightedTotal,
      totalWeight,
      totalPercent: percent,
      letterGrade: grade.letter,
      gradePoints: grade.points,
      midMarks: existing ? existing.midMarks : 0,
      finalMarks: existing ? existing.finalMarks : 0,
      resultId: existing ? existing.id : null,
      resultStatus: existing ? existing.status : 'DRAFT',
      workflowStage: existing ? existing.workflowStage || 'DRAFT' : 'DRAFT',
      editable: !existing || (existing.workflowStage || 'DRAFT') === 'DRAFT',
    };
  });

  const outCategories = categories.map((c) => ({
    ...c, items: c.items.map(({ getCell, ...rest }) => { void getCell; return rest; }),
  }));
  return {
    offering: {
      id: offering.id,
      courseId: offering.courseId,
      courseCode: offering.course?.code,
      courseTitle: offering.course?.title,
      creditHours: offering.course?.creditHours,
      hasLab: !!offering.course?.hasLab,
      term: offering.term?.title || null,
      program: offering.course?.program?.shortForm || offering.course?.program?.code || null,
      semester: offering.course?.semester?.number || null,
      midTotalMarks: midTotal,
      finalTotalMarks: finalTotal,
      configured,
      level,
      weights,
      resultLockedAt: offering.resultLockedAt,
      resultSubmittedAt: offering.resultSubmittedAt,
    },
    categories: outCategories,
    rows,
  };
}

/**
 * Persist the live gradebook aggregate into CourseResult (DRAFT rows only),
 * so every consumer reads identical figures. Returns affected student ids.
 */
async function syncResults(offeringOrId, opts = {}) {
  const gb = await buildGradebook(offeringOrId, opts);
  if (!gb) return [];
  const offeringId = gb.offering.id;
  const touched = [];
  const w = gb.offering.weights;
  for (const row of gb.rows) {
    if (!row.editable) continue;
    const c = row.components;
    const data = {
      assignmentMarks: c.assignment ? c.assignment.obtained : 0, assignmentMax: w.assignmentWeight || 100,
      quizMarks: c.quiz ? c.quiz.obtained : 0, quizMax: w.quizWeight || 100,
      labMarks: c.lab ? c.lab.obtained : 0, labMax: w.labWeight || 100,
      projectMarks: c.project ? c.project.obtained : 0, projectMax: w.projectWeight || 100,
      midMax: gb.offering.midTotalMarks || undefined,
      finalMax: gb.offering.finalTotalMarks || undefined,
      totalPercent: row.totalPercent, letterGrade: row.letterGrade, gradePoints: row.gradePoints,
    };
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    await prisma.courseResult.upsert({
      where: { offeringId_studentId: { offeringId, studentId: row.studentId } },
      update: data,
      create: { offeringId, studentId: row.studentId, status: 'DRAFT', ...data },
    });
    touched.push(row.studentId);
  }
  return touched;
}

/** Map a gradebook row onto the student-facing breakdown shape. */
function studentBreakdown(gb, row) {
  const components = [];
  for (const cat of gb.categories) {
    for (const it of cat.items) {
      const cell = row.cells[it.key] || {};
      components.push({
        key: it.key, category: cat.key, label: it.label,
        weight: it.itemWeight,
        obtained: cell.obtained, total: cell.total,
        weightedMarks: cell.converted,
        status: cell.pending ? 'PENDING' : 'GRADED',
      });
    }
  }
  return {
    offeringId: gb.offering.id,
    courseCode: gb.offering.courseCode,
    courseTitle: gb.offering.courseTitle,
    creditHours: gb.offering.creditHours,
    hasLab: gb.offering.hasLab,
    configured: gb.offering.configured,
    midTotalMarks: gb.offering.midTotalMarks,
    finalTotalMarks: gb.offering.finalTotalMarks,
    categories: gb.categories.map((c) => ({ key: c.key, label: c.label, weight: c.weight, obtained: row.components[c.key]?.obtained ?? 0 })),
    components,
    totalWeight: row.totalWeight,
    weightedTotal: row.weightedTotal,
    workflowStage: row.workflowStage,
  };
}

module.exports = { buildGradebook, syncResults, studentBreakdown, itemWeights };
