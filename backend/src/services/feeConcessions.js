// Provost concessions: apply, revise, revoke and condition review.
// A concession never edits the batch's locked semester fee; it discounts
// the selected heads on the student's challans from the next challan
// onward, for its configured duration.
const prisma = require('../utils/prisma');
const { safeJson } = require('../utils/lmsHelpers');
const { audit } = require('../utils/lmsAudit');
const { notify, notifyMany } = require('../utils/lmsNotify');
const { resolveStudents, resolveStudent } = require('./feeStudents');
const { cgpaOf } = require('./feeHolds');

const LIST_FILTERS = {
  waived: (c) => c.category === 'WAIVER' && c.status === 'ACTIVE',
  reduced: (c) => c.category === 'REDUCTION' && c.status === 'ACTIVE',
  scholarship: (c) => c.category === 'SCHOLARSHIP' && c.status === 'ACTIVE',
  expiring: (c) => c.expiringSoon,
  review: (c) => c.status === 'REVIEW',
  revoked: (c) => c.status === 'REVOKED',
};

function snapshot(c) {
  return {
    typeName: c.typeName, category: c.category, mode: c.mode, value: c.value,
    headIds: safeJson(c.headIds, []), startSemester: c.startSemester, endSemester: c.endSemester,
    minCgpa: c.minCgpa, status: c.status, reason: c.reason,
  };
}

function coverage(c) {
  if (c.endSemester == null) return `Semester ${c.startSemester} until the last semester`;
  return c.endSemester === c.startSemester ? `Semester ${c.startSemester}` : `Semesters ${c.startSemester}–${c.endSemester}`;
}

const valueLabel = (c) => (c.mode === 'PERCENT' ? `${c.value}%` : `Rs. ${Number(c.value).toLocaleString('en-PK')}`);

async function headNames(ids) {
  return (await prisma.feeHead.findMany({ where: { id: { in: ids } }, select: { name: true } })).map((h) => h.name);
}

function validate(body, category) {
  const waiver = category === 'WAIVER';
  const mode = waiver ? 'PERCENT' : String(body.mode || 'PERCENT').toUpperCase();
  const value = waiver ? 100 : Number(body.value);
  const headIds = (Array.isArray(body.headIds) ? body.headIds : safeJson(body.headIds, [])).map(Number).filter(Boolean);
  const startSemester = parseInt(body.startSemester, 10);
  const untilLast = String(body.durationType || 'SEMESTERS').toUpperCase() === 'UNTIL_LAST';
  const semesters = parseInt(body.semesters, 10);
  const minCgpa = body.minCgpa === '' || body.minCgpa == null ? null : Number(body.minCgpa);
  const reason = String(body.reason || '').trim();

  if (!['PERCENT', 'AMOUNT'].includes(mode)) return 'Mode must be a percentage or a flat amount';
  if (!(value > 0)) return 'Concession amount or percentage must be greater than zero';
  if (mode === 'PERCENT' && value > 100) return 'Percentage cannot exceed 100';
  if (!headIds.length) return 'Select at least one fee head';
  if (!(startSemester >= 1)) return 'Starting semester is required';
  if (!untilLast && !(semesters >= 1)) return 'Number of semesters is required';
  if (minCgpa != null && !(minCgpa >= 0 && minCgpa <= 4)) return 'CGPA condition must be between 0 and 4';
  if (reason.length < 5) return 'A reason is required';
  return {
    mode, value, headIds, startSemester, minCgpa, reason,
    endSemester: untilLast ? null : startSemester + semesters - 1,
  };
}

async function apply(req, { studentId, body, file }) {
  const student = await resolveStudent(studentId);
  if (!student) return { error: 'Student not found', status: 404 };
  const type = await prisma.concessionType.findUnique({ where: { id: parseInt(body.typeId, 10) || 0 } });
  if (!type || !type.isActive) return { error: 'Select a valid concession type', status: 400 };
  const data = validate({ ...body, startSemester: body.startSemester || student.semester }, type.category);
  if (typeof data === 'string') return { error: data, status: 400 };
  if (!file) return { error: 'A proof document is required', status: 400 };
  if (student.totalSemesters && data.endSemester && data.endSemester > student.totalSemesters) data.endSemester = student.totalSemesters;

  const c = await prisma.feeConcession.create({
    data: {
      studentId, typeId: type.id, typeName: type.name, category: type.category,
      ...data, headIds: JSON.stringify(data.headIds),
      proofPath: `/uploads/fee-proofs/${file.filename}`, proofName: file.originalname,
      createdById: req.lmsUser.id,
    },
  });
  await audit(req, 'CONCESSION_APPLY', 'FeeConcession', c.id, { after: { studentId, ...snapshot(c), proof: c.proofName } });
  const names = await headNames(data.headIds);
  await notify(studentId, {
    title: 'Fee concession applied',
    message: `${c.typeName} of ${valueLabel(c)} on ${names.join(', ')} for ${coverage(c).toLowerCase()}. Reason: ${c.reason}.${c.minCgpa != null ? ` Condition: maintain CGPA ≥ ${c.minCgpa}.` : ''} It applies from your next challan.`,
    type: 'FEE', link: '/student/account',
  });
  return { concession: c };
}

async function revise(req, id, body) {
  const c = await prisma.feeConcession.findUnique({ where: { id } });
  if (!c) return { error: 'Concession not found', status: 404 };
  if (c.status === 'REVOKED') return { error: 'A revoked concession cannot be revised', status: 409 };
  const data = validate({
    mode: body.mode ?? c.mode,
    value: body.value ?? c.value,
    headIds: body.headIds ?? safeJson(c.headIds, []),
    startSemester: body.startSemester ?? c.startSemester,
    durationType: body.durationType ?? (c.endSemester == null ? 'UNTIL_LAST' : 'SEMESTERS'),
    semesters: body.semesters ?? (c.endSemester == null ? 1 : c.endSemester - c.startSemester + 1),
    minCgpa: body.minCgpa !== undefined ? body.minCgpa : c.minCgpa,
    reason: body.reason,
  }, c.category);
  if (typeof data === 'string') return { error: data, status: 400 };
  const updated = await prisma.feeConcession.update({
    where: { id }, data: { ...data, headIds: JSON.stringify(data.headIds), status: 'ACTIVE', reviewNote: null },
  });
  await audit(req, 'CONCESSION_REVISE', 'FeeConcession', id, { before: snapshot(c), after: snapshot(updated) });
  const names = await headNames(data.headIds);
  await notify(c.studentId, {
    title: 'Fee concession revised',
    message: `Your ${updated.typeName} is now ${valueLabel(updated)} on ${names.join(', ')} for ${coverage(updated).toLowerCase()}. Reason: ${data.reason}.`,
    type: 'FEE', link: '/student/account',
  });
  return { concession: updated };
}

async function revoke(req, id, reason) {
  const c = await prisma.feeConcession.findUnique({ where: { id } });
  if (!c) return { error: 'Concession not found', status: 404 };
  if (c.status === 'REVOKED') return { error: 'Concession is already revoked', status: 409 };
  const why = String(reason || '').trim();
  if (why.length < 5) return { error: 'A reason is required to revoke a concession', status: 400 };
  const updated = await prisma.feeConcession.update({
    where: { id }, data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: why },
  });
  await audit(req, 'CONCESSION_REVOKE', 'FeeConcession', id, { before: snapshot(c), after: { ...snapshot(updated), revokeReason: why } });
  await notify(c.studentId, {
    title: 'Fee concession removed',
    message: `Your ${c.typeName} concession has been removed. Reason: ${why}. Future challans are issued without it.`,
    type: 'FEE', link: '/student/account',
  });
  return { concession: updated };
}

// Expire concessions whose duration has passed and flag those whose CGPA
// condition is no longer met. Flagged concessions stop discounting new
// challans and wait for the Provost to reinstate (revise) or revoke them —
// nothing is revoked automatically.
async function review(req) {
  const active = await prisma.feeConcession.findMany({ where: { status: 'ACTIVE' } });
  if (!active.length) return { flagged: 0, expired: 0 };
  const positions = await resolveStudents([...new Set(active.map((c) => c.studentId))]);
  const provosts = (await prisma.lmsUser.findMany({ where: { role: 'Provost', isActive: true }, select: { id: true } })).map((p) => p.id);
  let flagged = 0;
  let expired = 0;
  for (const c of active) {
    const pos = positions.get(c.studentId);
    if (!pos) continue;
    if (c.endSemester != null && pos.semester > c.endSemester) {
      await prisma.feeConcession.update({ where: { id: c.id }, data: { status: 'EXPIRED' } });
      await audit(req, 'CONCESSION_EXPIRE', 'FeeConcession', c.id, { before: { status: 'ACTIVE' }, after: { status: 'EXPIRED', semester: pos.semester }, actor: req ? undefined : { role: 'System' } });
      expired += 1;
      continue;
    }
    if (c.minCgpa == null) continue;
    const cgpa = await cgpaOf(c.studentId);
    if (cgpa == null || cgpa >= c.minCgpa) continue;
    const note = `CGPA ${cgpa.toFixed(2)} is below the required ${c.minCgpa}`;
    await prisma.feeConcession.update({ where: { id: c.id }, data: { status: 'REVIEW', reviewNote: note } });
    await audit(req, 'CONCESSION_FLAG', 'FeeConcession', c.id, { before: { status: 'ACTIVE' }, after: { status: 'REVIEW', reviewNote: note }, actor: req ? undefined : { role: 'System' } });
    await notifyMany(provosts, {
      title: 'Concession needs review',
      message: `${pos.fullName} (${pos.rollNumber}): ${c.typeName} — ${note}. Reinstate or revoke it from Concessions.`,
      type: 'FEE', link: '/provost/concessions',
    });
    flagged += 1;
  }
  return { flagged, expired };
}

async function list(filters = {}) {
  const rows = await prisma.feeConcession.findMany({
    where: filters.studentId ? { studentId: filters.studentId } : {}, orderBy: { createdAt: 'desc' },
  });
  const positions = await resolveStudents([...new Set(rows.map((r) => r.studentId))]);
  const heads = new Map((await prisma.feeHead.findMany()).map((h) => [h.id, h.name]));
  const items = rows.map((c) => {
    const p = positions.get(c.studentId) || {};
    const headIds = safeJson(c.headIds, []);
    return {
      id: c.id,
      studentId: c.studentId,
      rollNumber: p.rollNumber,
      name: p.fullName,
      cnic: p.cnic,
      program: p.program,
      batch: p.batch,
      semester: p.semester,
      typeId: c.typeId,
      typeName: c.typeName,
      category: c.category,
      mode: c.mode,
      value: c.value,
      valueLabel: valueLabel(c),
      headIds,
      heads: headIds.map((id) => heads.get(id)).filter(Boolean).join(', '),
      startSemester: c.startSemester,
      endSemester: c.endSemester,
      coverage: coverage(c),
      minCgpa: c.minCgpa,
      reason: c.reason,
      proofPath: c.proofPath,
      proofName: c.proofName,
      status: c.status,
      reviewNote: c.reviewNote,
      revokeReason: c.revokeReason,
      revokedAt: c.revokedAt,
      // Ends with the student's current semester: next challan won't carry it.
      expiringSoon: c.status === 'ACTIVE' && c.endSemester != null && p.semester != null && c.endSemester <= p.semester,
      createdAt: c.createdAt,
    };
  });
  const pick = LIST_FILTERS[filters.list];
  return items.filter((i) => (!pick || pick(i))
    && (!filters.program || i.program === filters.program)
    && (!filters.batch || i.batch === filters.batch)
    && (!filters.semester || String(i.semester) === String(filters.semester)));
}

async function trail(id) {
  return prisma.lmsAuditLog.findMany({
    where: { entity: 'FeeConcession', entityId: String(id) },
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { username: true, profile: { select: { fullName: true } } } } },
  });
}

module.exports = { apply, revise, revoke, review, list, trail };
