// Resolves where every student stands for billing: program, batch
// (admission session) and current semester. The semester comes from the
// same logic the LMS auto-enrolment uses, so fees and academics agree.
const prisma = require('../utils/prisma');
const { determineCurrentSemester } = require('./autoEnrollService');

const PROFILE_SELECT = {
  fullName: true, fatherName: true, cnic: true, rollNumber: true, registrationNumber: true,
  program: true, programShortForm: true, department: true, session: true,
  phone: true, email: true, photoUrl: true,
};

async function programIndex() {
  const programs = await prisma.lmsProgram.findMany({
    where: { isDeleted: false },
    select: { id: true, code: true, shortForm: true, name: true, totalSemesters: true },
  });
  const byKey = new Map();
  for (const p of programs) {
    for (const k of [p.code, p.shortForm, p.name]) if (k) byKey.set(String(k).toUpperCase(), p);
  }
  return byKey;
}

function shape(user, program, semester) {
  const p = user.profile || {};
  return {
    studentId: user.id,
    rollNumber: p.rollNumber || user.username,
    registrationNumber: p.registrationNumber || '',
    fullName: p.fullName || user.username,
    fatherName: p.fatherName || '',
    cnic: p.cnic || '',
    email: p.email || user.email || '',
    phone: p.phone || '',
    photoUrl: p.photoUrl || null,
    program: program?.code || p.programShortForm || '',
    programName: program?.name || p.program || '',
    department: p.department || '',
    batch: p.session || '',
    semester,
    totalSemesters: program?.totalSemesters || null,
    isActive: user.isActive,
  };
}

// Map<studentId, position> for every student, or only the given ids.
async function resolveStudents(ids) {
  const where = { role: 'Student' };
  if (ids) where.id = { in: ids };
  const [users, programs] = await Promise.all([
    prisma.lmsUser.findMany({
      where,
      select: { id: true, username: true, email: true, isActive: true, profile: { select: PROFILE_SELECT } },
      orderBy: { username: 'asc' },
    }),
    programIndex(),
  ]);
  const map = new Map();
  for (const u of users) {
    const p = u.profile || {};
    const program = programs.get(String(p.programShortForm || p.program || '').toUpperCase()) || null;
    const semester = program ? (await determineCurrentSemester(u.id, program.id)).number : 1;
    map.set(u.id, shape(u, program, semester));
  }
  return map;
}

async function resolveStudent(studentId) {
  return (await resolveStudents([studentId])).get(studentId) || null;
}

// Free-text search across Reg No / Roll No / Name / CNIC.
function matchesQuery(pos, q) {
  if (!q) return true;
  const needle = String(q).trim().toLowerCase();
  return [pos.rollNumber, pos.registrationNumber, pos.fullName, pos.cnic, pos.email]
    .some((v) => String(v || '').toLowerCase().includes(needle));
}

// Fees the student already paid during admissions (processing fee and
// admission fee), read from Enrollment -> Application / FeePayment. Read-only.
// Returned as PAID, non-payable challan-shaped entries.
async function resolveAdmissionFeeEntries(lmsUserId) {
  const entries = [];
  // Link LMS student → admissions Enrollment → admissions User.
  const enrollment = await prisma.enrollment.findFirst({ where: { lmsUserId } }).catch(() => null);
  if (!enrollment || !enrollment.userId) return entries;

  // Latest application for this admissions user (carries the processing-fee
  // flags and the linked FeePayment for the admission fee).
  const application = await prisma.application.findFirst({
    where: { userId: enrollment.userId },
    orderBy: { submittedAt: 'desc' },
    include: { feePayment: true, admissionCycle: true },
  }).catch(() => null);
  if (!application) return entries;

  // 1. Application processing fee (paid at application time).
  if (application.procFeePaid) {
    const amount = application.admissionCycle ? Number(application.admissionCycle.applicationProcessingFee || 0) : 0;
    entries.push({
      id: `adm-proc-${application.id}`,
      challanNo: application.procFeeTxnId || `APP-${application.id}`,
      title: 'Application Processing Fee (Admission)',
      lineItems: [{ label: 'Application processing fee', amount }],
      totalAmount: amount,
      dueDate: null,
      status: 'PAID',
      paidAt: application.procFeePaidAt || null,
      paymentRef: application.procFeeTxnId || null,
      createdAt: application.submittedAt || null,
      source: 'admission',
      readOnly: true,
    });
  }

  // 2. Admission / enrollment fee (the FeePayment approved during admissions).
  const fp = application.feePayment;
  if (fp && (String(fp.status || '').toUpperCase() === 'APPROVED' || String(fp.status || '').toUpperCase() === 'PAID' || fp.paidAt)) {
    const amount = Number(fp.amount || 0);
    entries.push({
      id: `adm-fee-${fp.id}`,
      challanNo: fp.txnId || `ADM-${fp.id}`,
      title: 'Admission Fee',
      lineItems: [{ label: 'Admission / enrollment fee', amount }],
      totalAmount: amount,
      dueDate: null,
      status: 'PAID',
      paidAt: fp.paidAt || null,
      paymentRef: fp.txnId || null,
      createdAt: fp.createdAt || null,
      source: 'admission',
      readOnly: true,
    });
  }

  return entries;
}

module.exports = { resolveStudents, resolveStudent, matchesQuery, resolveAdmissionFeeEntries };
