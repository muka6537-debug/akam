// Unpaid-dues holds. A student with an overdue challan is blocked from
// course registration and admit-card generation, and their promotion is
// set to "Hold", until the dues are cleared. Holds are derived from
// challan state, so a confirmed payment lifts them immediately.
const prisma = require('../utils/prisma');
const { overdueChallans, money, round2 } = require('./feeBilling');
const { resolveStudents, matchesQuery } = require('./feeStudents');
const { computeGPA } = require('../utils/lmsGrading');

const HOLD_MESSAGE = 'You have unpaid fee dues. Clear your overdue challans in the Fee Account to continue.';
const outstandingOf = (c) => round2(c.totalAmount + (c.lateFee || 0) - c.paidAmount);

async function holdStatus(studentId) {
  const overdue = await overdueChallans([studentId]);
  const outstanding = round2(overdue.reduce((s, c) => s + outstandingOf(c), 0));
  const onHold = overdue.length > 0;
  return {
    onHold,
    outstanding,
    challans: overdue.map((c) => ({ id: c.id, challanNo: c.challanNo, title: c.title, dueDate: c.dueDate })),
    courseRegistration: onHold ? 'BLOCKED' : 'ALLOWED',
    admitCard: onHold ? 'BLOCKED' : 'ALLOWED',
    promotion: onHold ? 'HOLD' : 'CLEAR',
    message: onHold ? `${HOLD_MESSAGE} Outstanding: ${money(outstanding)}.` : null,
  };
}

async function assertNoDues(studentId, action) {
  const { onHold, outstanding } = await holdStatus(studentId);
  if (!onHold) return;
  const e = new Error(`${action} is on hold — ${HOLD_MESSAGE} Outstanding: ${money(outstanding)}.`);
  e.status = 402;
  e.expose = true;
  throw e;
}

// Map<studentId, outstanding> of every student currently on hold.
async function heldStudents(studentIds) {
  const map = new Map();
  for (const c of await overdueChallans(studentIds)) map.set(c.studentId, round2((map.get(c.studentId) || 0) + outstandingOf(c)));
  return map;
}

async function defaulters(filters = {}) {
  const overdue = await overdueChallans();
  const byStudent = new Map();
  for (const c of overdue) {
    const e = byStudent.get(c.studentId) || { challans: 0, outstanding: 0, lateFee: 0, oldestDue: null };
    e.challans += 1;
    e.outstanding = round2(e.outstanding + outstandingOf(c));
    e.lateFee = round2(e.lateFee + (c.lateFee || 0));
    if (!e.oldestDue || c.dueDate < e.oldestDue) e.oldestDue = c.dueDate;
    byStudent.set(c.studentId, e);
  }
  if (!byStudent.size) return [];
  const positions = await resolveStudents([...byStudent.keys()]);
  return [...byStudent.entries()]
    .map(([studentId, e]) => {
      const p = positions.get(studentId) || {};
      return {
        studentId,
        rollNumber: p.rollNumber,
        name: p.fullName,
        cnic: p.cnic,
        program: p.program,
        batch: p.batch,
        semester: p.semester,
        overdueChallans: e.challans,
        outstanding: e.outstanding,
        lateFee: e.lateFee,
        oldestDue: e.oldestDue,
        daysOverdue: e.oldestDue ? Math.max(0, Math.floor((Date.now() - new Date(`${e.oldestDue}T23:59:59`)) / 86400000)) : 0,
        holds: 'Course Registration, Admit Card, Promotion (Hold)',
      };
    })
    .filter((r) => (!filters.program || r.program === filters.program)
      && (!filters.batch || r.batch === filters.batch)
      && (!filters.semester || String(r.semester) === String(filters.semester))
      && matchesQuery({ rollNumber: r.rollNumber, fullName: r.name, cnic: r.cnic }, filters.q))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

async function cgpaOf(studentId) {
  const results = await prisma.courseResult.findMany({
    where: { studentId, status: 'PUBLISHED' },
    include: { offering: { include: { course: { select: { creditHours: true } } } } },
  });
  if (!results.length) return null;
  return computeGPA(results.map((r) => ({ gradePoints: r.gradePoints, letterGrade: r.letterGrade, creditHours: r.offering?.course?.creditHours || 3 })));
}

module.exports = { HOLD_MESSAGE, holdStatus, assertNoDues, heldStudents, defaulters, cgpaOf };
