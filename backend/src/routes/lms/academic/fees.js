// Centralized Fee Module — /api/lms/academic/fees/*
//
//   Provost       fee notifications, concessions
//   Finance       payment confirmation, fee heads, payment methods, charges
//   Provost / Finance / Focal Person   reports, defaulter list, exports
//   Course Coordinator                 special-semester fee, resit, late registration
//   Student       own fee account (/me), online payment, hold status
const express = require('express');
const { body } = require('express-validator');
const prisma = require('../../../utils/prisma');
const { lmsAuth, lmsRequireRole } = require('../../../middleware/lmsAuth');
const { validate } = require('../../../middleware/validate');
const { uploadFeeProof } = require('../../../middleware/upload');
const { asyncHandler, httpError, safeJson } = require('../../../utils/lmsHelpers');
const { audit } = require('../../../utils/lmsAudit');
const structure = require('../../../services/feeStructure');
const billing = require('../../../services/feeBilling');
const concessions = require('../../../services/feeConcessions');
const holds = require('../../../services/feeHolds');
const exporter = require('../../../services/feeExports');
const {
  resolveStudents, resolveStudent, matchesQuery, resolveAdmissionFeeEntries,
} = require('../../../services/feeStudents');

const router = express.Router();
router.use(lmsAuth);

const PROVOST = lmsRequireRole('Provost');
const FINANCE = lmsRequireRole('Finance');
const OVERSIGHT = lmsRequireRole('Provost', 'Finance', 'FocalPerson');
const STAFF = lmsRequireRole('Provost', 'Finance', 'FocalPerson', 'CourseCoordinator');
const CHARGES = lmsRequireRole('Finance', 'CourseCoordinator');
const STUDENT = lmsRequireRole('Student');

const { round2, money, CHARGE_RATES } = billing;
const fail = (r) => { if (r && r.error) throw httpError(r.status || 400, r.error); return r; };
const filtersOf = (q) => ({ program: q.program || '', batch: q.batch || '', semester: q.semester || '', q: q.q || '' });
const inFilters = (row, f) => (!f.program || row.program === f.program)
  && (!f.batch || row.batch === f.batch)
  && (!f.semester || String(row.semester) === String(f.semester));
const filterLabel = (f) => ['program', 'batch', 'semester']
  .filter((k) => f[k]).map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${f[k]}`).join(' · ') || 'All programs, batches and semesters';
const stamp = () => `Generated ${new Date().toLocaleString('en-GB')}`;

// ============================================================
// Configuration
// ============================================================
router.get('/config', STAFF, asyncHandler(async (req, res) => {
  const [heads, methods, types, structures, positions] = await Promise.all([
    structure.listHeads({ includeInactive: true }),
    prisma.lmsPaymentMethod.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.concessionType.findMany({ orderBy: { name: 'asc' } }),
    prisma.batchFeeStructure.findMany({ orderBy: [{ programCode: 'asc' }, { batch: 'desc' }] }),
    resolveStudents(),
  ]);
  const students = [...positions.values()];
  const distinct = (xs) => [...new Set(xs.filter((x) => x != null && x !== ''))];
  res.json({
    heads,
    methods,
    concessionTypes: types,
    structures: structures.map(structure.shapeStructure),
    rates: CHARGE_RATES,
    filters: {
      programs: distinct([...students.map((p) => p.program), ...structures.map((s) => s.programCode)]).sort(),
      batches: distinct([...students.map((p) => p.batch), ...structures.map((s) => s.batch)]).sort(),
      semesters: distinct(students.map((p) => p.semester)).sort((a, b) => a - b),
    },
  });
}));

router.post('/heads', FINANCE, validate([
  body('name').isString().trim().isLength({ min: 2 }).withMessage('Name is required'),
  body('category').isIn(['ONE_TIME', 'OTHER', 'CHARGE']).withMessage('Category must be ONE_TIME, OTHER or CHARGE'),
]), asyncHandler(async (req, res) => {
  const { name, category } = req.body;
  const head = await prisma.feeHead.create({
    data: {
      name: name.trim(), category, sortOrder: 40,
      isRecurring: category === 'OTHER' ? !!req.body.isRecurring : false,
      isLocked: category === 'ONE_TIME' ? true : !!req.body.isLocked,
    },
  });
  await audit(req, 'FEE_HEAD_CREATE', 'FeeHead', head.id, { after: head });
  res.status(201).json({ head });
}));

router.put('/heads/:id', FINANCE, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const head = await prisma.feeHead.findUnique({ where: { id } });
  if (!head) throw httpError(404, 'Fee head not found');
  const flagsChanged = req.body.isRecurring !== undefined || req.body.isLocked !== undefined;
  if (flagsChanged && head.category !== 'OTHER') {
    throw httpError(409, `${head.name} is a ${head.category.toLowerCase().replace('_', '-')} head; only "Other" heads have configurable flags.`);
  }
  const data = {};
  for (const k of ['isRecurring', 'isLocked', 'isActive']) if (req.body[k] !== undefined) data[k] = !!req.body[k];
  const updated = await prisma.feeHead.update({ where: { id }, data });
  await audit(req, 'FEE_HEAD_UPDATE', 'FeeHead', id, { before: head, after: updated });
  res.json({ head: updated });
}));

// Revise a revisable head inside a Program + Batch structure. Locked
// items, including the semester-fee snapshot, are rejected.
router.put('/structures/:id/items/:headId', FINANCE, validate([
  body('amount').isFloat({ min: 0 }).withMessage('Amount must be zero or more'),
]), asyncHandler(async (req, res) => {
  res.json(fail(await structure.reviseItem(req, parseInt(req.params.id, 10), parseInt(req.params.headId, 10), req.body.amount)));
}));

router.post('/methods', FINANCE, validate([
  body('code').isString().trim().matches(/^[A-Z0-9_]{2,20}$/).withMessage('Code must be 2–20 upper-case letters, digits or _'),
  body('label').isString().trim().isLength({ min: 2 }).withMessage('Label is required'),
  body('confirmMode').isIn(['INSTANT', 'MANUAL']),
]), asyncHandler(async (req, res) => {
  const method = await prisma.lmsPaymentMethod.create({
    data: { code: req.body.code, label: req.body.label.trim(), confirmMode: req.body.confirmMode, instructions: req.body.instructions || null, sortOrder: 50 },
  });
  await audit(req, 'PAYMENT_METHOD_CREATE', 'LmsPaymentMethod', method.id, { after: method });
  res.status(201).json({ method });
}));

router.put('/methods/:id', FINANCE, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const before = await prisma.lmsPaymentMethod.findUnique({ where: { id } });
  if (!before) throw httpError(404, 'Payment method not found');
  const data = {};
  for (const k of ['label', 'instructions', 'confirmMode']) if (req.body[k] !== undefined) data[k] = req.body[k];
  if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
  const method = await prisma.lmsPaymentMethod.update({ where: { id }, data });
  await audit(req, 'PAYMENT_METHOD_UPDATE', 'LmsPaymentMethod', id, { before, after: method });
  res.json({ method });
}));

router.post('/concession-types', PROVOST, validate([
  body('name').isString().trim().isLength({ min: 2 }).withMessage('Name is required'),
  body('category').isIn(['WAIVER', 'REDUCTION', 'SCHOLARSHIP']),
]), asyncHandler(async (req, res) => {
  const type = await prisma.concessionType.create({ data: { name: req.body.name.trim(), category: req.body.category } });
  await audit(req, 'CONCESSION_TYPE_CREATE', 'ConcessionType', type.id, { after: type });
  res.status(201).json({ type });
}));

// ============================================================
// Provost fee notifications
// ============================================================
function shapeNotification(n, progress) {
  return {
    ...n,
    programs: safeJson(n.programs, []),
    batches: safeJson(n.batches, []),
    semesters: safeJson(n.semesters, []),
    items: safeJson(n.items, []),
    skipped: safeJson(n.skippedJson, []),
    progress: progress || { challans: 0, paid: 0, partial: 0, unpaid: 0, overdue: 0, waived: 0, billed: 0, collected: 0, collectionRate: 0 },
  };
}

async function notificationProgress(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await prisma.lmsFeeChallan.groupBy({
    by: ['notificationId', 'status'], where: { notificationId: { in: ids } },
    _count: { _all: true }, _sum: { totalAmount: true, paidAmount: true, lateFee: true },
  });
  for (const r of rows) {
    const s = map.get(r.notificationId) || { challans: 0, paid: 0, partial: 0, unpaid: 0, overdue: 0, waived: 0, billed: 0, collected: 0 };
    s.challans += r._count._all;
    s[r.status.toLowerCase()] += r._count._all;
    if (r.status !== 'WAIVED') s.billed = round2(s.billed + (r._sum.totalAmount || 0) + (r._sum.lateFee || 0));
    s.collected = round2(s.collected + (r._sum.paidAmount || 0));
    map.set(r.notificationId, s);
  }
  for (const s of map.values()) s.collectionRate = s.billed ? Math.round((s.collected / s.billed) * 100) : 0;
  return map;
}

router.get('/notifications', OVERSIGHT, asyncHandler(async (req, res) => {
  await billing.refreshOpenChallans();
  const rows = await prisma.feeNotification.findMany({ orderBy: { createdAt: 'desc' } });
  const progress = await notificationProgress(rows.map((r) => r.id));
  res.json({ items: rows.map((n) => shapeNotification(n, progress.get(n.id))) });
}));

router.get('/notifications/:id', OVERSIGHT, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const n = await prisma.feeNotification.findUnique({ where: { id } });
  if (!n) throw httpError(404, 'Notification not found');
  await billing.refreshOpenChallans({ notificationId: id });
  const challans = await prisma.lmsFeeChallan.findMany({ where: { notificationId: id }, orderBy: { createdAt: 'asc' } });
  const positions = await resolveStudents(challans.map((c) => c.studentId));
  const progress = await notificationProgress([id]);
  res.json({
    notification: shapeNotification(n, progress.get(id)),
    challans: challans.map((c) => ({ ...billing.shapeChallan(c), rollNumber: positions.get(c.studentId)?.rollNumber, name: positions.get(c.studentId)?.fullName })),
  });
}));

router.post('/notifications', PROVOST, validate([
  body('title').isString().trim().isLength({ min: 3 }).withMessage('Title is required'),
  body('dueDate').isISO8601().withMessage('Last date for payment is required'),
  body('programs').isArray({ min: 1 }).withMessage('Select at least one program'),
  body('batches').isArray({ min: 1 }).withMessage('Select at least one batch'),
  body('semesters').isArray({ min: 1 }).withMessage('Select at least one semester'),
  body('items').optional().isArray(),
  body('lateFeeType').optional().isIn(['NONE', 'FLAT', 'PER_DAY']),
  body('lateFeeAmount').optional().isFloat({ min: 0 }),
]), asyncHandler(async (req, res) => {
  const items = (req.body.items || [])
    .map((i) => ({ headId: i.headId ? Number(i.headId) : null, name: String(i.name || '').trim(), amount: Number(i.amount) || 0 }))
    .filter((i) => i.name && i.amount > 0);
  const includeSemesterDues = req.body.includeSemesterDues !== false;
  if (!includeSemesterDues && !items.length) throw httpError(400, 'Add at least one fee head and amount');
  const lateFeeType = req.body.lateFeeType || 'NONE';
  const lateFeeAmount = lateFeeType === 'NONE' ? 0 : Number(req.body.lateFeeAmount) || 0;
  if (lateFeeType !== 'NONE' && !(lateFeeAmount > 0)) throw httpError(400, 'Late fee amount is required');

  const n = await prisma.feeNotification.create({
    data: {
      title: req.body.title.trim(),
      description: req.body.description || null,
      programs: JSON.stringify(req.body.programs),
      batches: JSON.stringify(req.body.batches),
      semesters: JSON.stringify(req.body.semesters.map(Number)),
      items: JSON.stringify(items),
      includeSemesterDues,
      dueDate: String(req.body.dueDate).slice(0, 10),
      lateFeeType,
      lateFeeAmount,
      createdById: req.lmsUser.id,
    },
  });
  await audit(req, 'FEE_NOTIFICATION_ANNOUNCE', 'FeeNotification', n.id, { after: shapeNotification(n) });
  const result = await billing.generateForNotification(n);
  const fresh = await prisma.feeNotification.findUnique({ where: { id: n.id } });
  const progress = await notificationProgress([n.id]);
  res.status(201).json({ notification: shapeNotification(fresh, progress.get(n.id)), ...result });
}));

// Re-run generation, e.g. after a missing batch structure has been synced
// or new students joined a targeted batch.
router.post('/notifications/:id/regenerate', PROVOST, asyncHandler(async (req, res) => {
  const n = await prisma.feeNotification.findUnique({ where: { id: parseInt(req.params.id, 10) } });
  if (!n) throw httpError(404, 'Notification not found');
  if (n.status !== 'ACTIVE') throw httpError(409, 'Notification is closed');
  const result = await billing.generateForNotification(n);
  await audit(req, 'FEE_NOTIFICATION_REGENERATE', 'FeeNotification', n.id, { after: { generated: result.generated, skipped: result.skipped.length } });
  res.json(result);
}));

router.post('/notifications/:id/close', PROVOST, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const n = await prisma.feeNotification.findUnique({ where: { id } });
  if (!n) throw httpError(404, 'Notification not found');
  const updated = await prisma.feeNotification.update({ where: { id }, data: { status: 'CLOSED' } });
  await audit(req, 'FEE_NOTIFICATION_CLOSE', 'FeeNotification', id, { before: { status: n.status }, after: { status: 'CLOSED' } });
  res.json({ notification: shapeNotification(updated) });
}));

// ============================================================
// Student search + fee profile
// ============================================================
router.get('/students', STAFF, asyncHandler(async (req, res) => {
  const f = filtersOf(req.query);
  const list = [...(await resolveStudents()).values()].filter((p) => inFilters(p, f) && matchesQuery(p, f.q));
  res.json({ items: list.slice(0, 200), total: list.length });
}));

router.get('/students/:id', OVERSIGHT, asyncHandler(async (req, res) => {
  const student = await resolveStudent(req.params.id);
  if (!student) throw httpError(404, 'Student not found');
  const [dues, hold, conc, struct] = await Promise.all([
    billing.studentDues(student.studentId),
    holds.holdStatus(student.studentId),
    concessions.list({ studentId: student.studentId }),
    structure.structureFor(student.program, student.batch),
  ]);
  res.json({ student, structure: struct, ...dues, hold, concessions: conc });
}));

// ============================================================
// Concessions
// ============================================================
router.get('/concessions', OVERSIGHT, asyncHandler(async (req, res) => {
  res.json({ items: await concessions.list({ ...filtersOf(req.query), list: req.query.list }) });
}));

router.post('/concessions', PROVOST, uploadFeeProof.single('proof'), asyncHandler(async (req, res) => {
  res.status(201).json(fail(await concessions.apply(req, { studentId: req.body.studentId, body: req.body, file: req.file })));
}));

router.post('/concessions/review', PROVOST, asyncHandler(async (req, res) => {
  res.json(await concessions.review(req));
}));

router.put('/concessions/:id', PROVOST, validate([
  body('reason').isString().trim().isLength({ min: 5 }).withMessage('A reason for the revision is required'),
]), asyncHandler(async (req, res) => {
  res.json(fail(await concessions.revise(req, parseInt(req.params.id, 10), req.body)));
}));

router.post('/concessions/:id/revoke', PROVOST, asyncHandler(async (req, res) => {
  res.json(fail(await concessions.revoke(req, parseInt(req.params.id, 10), req.body.reason)));
}));

router.get('/concessions/:id/trail', OVERSIGHT, asyncHandler(async (req, res) => {
  const rows = await concessions.trail(parseInt(req.params.id, 10));
  res.json({
    items: rows.map((r) => ({
      id: r.id, action: r.action, createdAt: r.createdAt, actorRole: r.actorRole,
      actor: r.actor ? (r.actor.profile?.fullName || r.actor.username) : r.actorRole,
      before: safeJson(r.beforeJson, null), after: safeJson(r.afterJson, null),
    })),
  });
}));

// ============================================================
// Challans + payments
// ============================================================
router.get('/challans', OVERSIGHT, asyncHandler(async (req, res) => {
  const f = filtersOf(req.query);
  await billing.refreshOpenChallans();
  const where = {};
  if (req.query.status) where.status = { in: String(req.query.status).toUpperCase().split(',') };
  if (req.query.kind) where.kind = String(req.query.kind).toUpperCase();
  const rows = await prisma.lmsFeeChallan.findMany({ where, orderBy: { createdAt: 'desc' }, include: { payments: true }, take: 1000 });
  const positions = await resolveStudents([...new Set(rows.map((r) => r.studentId))]);
  const items = rows
    .map((c) => {
      const p = positions.get(c.studentId) || {};
      return { ...billing.shapeChallan(c), rollNumber: p.rollNumber, name: p.fullName, cnic: p.cnic };
    })
    .filter((c) => inFilters(c, f) && (!f.q || matchesQuery({ rollNumber: c.rollNumber, fullName: c.name, cnic: c.cnic, registrationNumber: c.challanNo }, f.q)));
  res.json({ items });
}));

// Finance confirms a bank deposit / counter payment, or a gateway
// settlement. Same confirmation path as student online payments.
router.post('/challans/:id/payments', FINANCE, validate([
  body('method').isString().notEmpty().withMessage('Payment method is required'),
  body('amount').optional({ values: 'falsy' }).isFloat({ gt: 0 }),
  body('reference').isString().trim().isLength({ min: 3 }).withMessage('Bank / counter reference is required'),
]), asyncHandler(async (req, res) => {
  res.status(201).json(fail(await billing.recordPayment({
    req, challanId: parseInt(req.params.id, 10), amount: req.body.amount, method: req.body.method,
    channel: req.body.channel === 'GATEWAY' ? 'GATEWAY' : 'FINANCE', reference: req.body.reference.trim(), note: req.body.note,
  })));
}));

router.get('/challans/:id/pdf', lmsRequireRole('Provost', 'Finance', 'FocalPerson', 'Student'), asyncHandler(async (req, res) => {
  const c = await prisma.lmsFeeChallan.findUnique({ where: { id: parseInt(req.params.id, 10) }, include: { payments: true } });
  if (!c || (req.lmsUser.role === 'Student' && c.studentId !== req.lmsUser.id)) throw httpError(404, 'Challan not found');
  exporter.challanPdf(res, billing.shapeChallan(c), (await resolveStudent(c.studentId)) || {});
}));

// ============================================================
// Charges: frozen / vacant semester, resit, special semester,
// late registration
// ============================================================
router.post('/charges/freeze', FINANCE, validate([
  body('studentId').isString().notEmpty().withMessage('Select a student'),
  body('mode').isIn(['FREEZE', 'VACANT']),
]), asyncHandler(async (req, res) => {
  const student = await resolveStudent(req.body.studentId);
  if (!student) throw httpError(404, 'Student not found');
  const struct = await structure.structureFor(student.program, student.batch);
  if (!struct || !struct.semesterFee) throw httpError(409, `No locked semester fee is synced for ${student.program} – ${student.batch}`);
  const label = req.body.mode === 'FREEZE' ? 'Frozen' : 'Vacant';
  res.status(201).json(fail(await billing.raiseCharge({
    req, studentId: student.studentId, kind: 'FREEZE', headName: 'Freeze Fee',
    amount: round2(struct.semesterFee * CHARGE_RATES.FREEZE_SHARE),
    title: `${label} Semester ${student.semester} — 25% of tuition`,
    description: `${label} semester: 25% of the locked semester fee (${money(struct.semesterFee)}).${req.body.note ? ` ${req.body.note}` : ''}`,
  })));
}));

router.post('/charges/resit', CHARGES, validate([
  body('studentId').isString().notEmpty().withMessage('Select a student'),
  body('courses').isArray({ min: 1 }).withMessage('Select at least one course'),
]), asyncHandler(async (req, res) => {
  const codes = req.body.courses.map(String);
  res.status(201).json(fail(await billing.raiseCharge({
    req, studentId: req.body.studentId, kind: 'RESIT', headName: 'Resit Fee',
    amount: CHARGE_RATES.RESIT_PER_COURSE * codes.length,
    title: `Resit Fee — ${codes.length} course(s)`,
    description: `Resit at ${money(CHARGE_RATES.RESIT_PER_COURSE)} per course: ${codes.join(', ')}`,
  })));
}));

router.post('/charges/special-semester', lmsRequireRole('CourseCoordinator'), validate([
  body('studentIds').isArray({ min: 1 }).withMessage('Select at least one student'),
  body('amount').isFloat({ gt: 0 }).withMessage('Fee amount is required'),
]), asyncHandler(async (req, res) => {
  const title = (req.body.title || '').trim() || 'Special Semester Fee';
  const challanIds = [];
  for (const studentId of req.body.studentIds) {
    const r = await billing.raiseCharge({
      req, studentId, kind: 'SPECIAL_SEMESTER', headName: 'Special Semester Fee', amount: Number(req.body.amount), title,
      description: `Special semester fee set by the Course Coordinator.${req.body.note ? ` ${req.body.note}` : ''}`,
    });
    if (r.challan) challanIds.push(r.challan.id);
  }
  res.status(201).json({ created: challanIds.length, challanIds });
}));

router.post('/charges/late-registration', CHARGES, validate([
  body('studentId').isString().notEmpty().withMessage('Select a student'),
  body('amount').optional({ values: 'falsy' }).isFloat({ gt: 0 }),
]), asyncHandler(async (req, res) => {
  res.status(201).json(fail(await billing.raiseCharge({
    req, studentId: req.body.studentId, kind: 'LATE_REGISTRATION', headName: 'Late Registration Fee',
    amount: Number(req.body.amount) || CHARGE_RATES.LATE_REGISTRATION,
    title: 'Late Registration Fee',
    description: req.body.note || 'Course registration after the registration deadline.',
  })));
}));

// ============================================================
// Reports, concession lists, defaulters — JSON + Excel/PDF export
// ============================================================
const CHALLAN_COLUMNS = [
  { header: 'Challan #', key: 'challanNo', width: 18 },
  { header: 'Roll No', key: 'rollNumber', width: 14 },
  { header: 'Student', key: 'name', width: 22 },
  { header: 'Program', key: 'program', width: 9 },
  { header: 'Batch', key: 'batch', width: 11 },
  { header: 'Sem', key: 'semester', width: 5 },
  { header: 'Title', key: 'title', width: 24 },
  { header: 'Due Date', key: 'dueDate', width: 11 },
  { header: 'Net Due', key: 'payable', width: 11, money: true },
  { header: 'Paid', key: 'paidAmount', width: 11, money: true },
  { header: 'Remaining', key: 'remaining', width: 11, money: true },
  { header: 'Status', key: 'status', width: 9 },
];

const REPORTS = {
  paid: { title: 'Paid Fee Report', status: 'PAID' },
  unpaid: { title: 'Unpaid Fee Report', status: 'UNPAID' },
  partial: { title: 'Partially Paid Fee Report', status: 'PARTIAL' },
  overdue: { title: 'Overdue Fee Report', status: 'OVERDUE' },
};

async function challanReport(kind, f) {
  const def = REPORTS[kind];
  if (!def) throw httpError(404, 'Unknown report');
  await billing.refreshOpenChallans();
  const rows = await prisma.lmsFeeChallan.findMany({ where: { status: def.status }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] });
  const positions = await resolveStudents([...new Set(rows.map((r) => r.studentId))]);
  const items = rows
    .map((c) => ({ ...billing.shapeChallan(c), rollNumber: positions.get(c.studentId)?.rollNumber, name: positions.get(c.studentId)?.fullName }))
    .filter((c) => inFilters(c, f));
  return {
    title: def.title,
    subtitle: `${filterLabel(f)} · ${items.length} challan(s) · ${stamp()}`,
    columns: CHALLAN_COLUMNS,
    rows: items,
    totals: {
      count: items.length,
      payable: round2(items.reduce((s, c) => s + c.payable, 0)),
      paid: round2(items.reduce((s, c) => s + c.paidAmount, 0)),
      remaining: round2(items.reduce((s, c) => s + c.remaining, 0)),
    },
  };
}

const CONCESSION_LISTS = {
  waived: 'Waived Students',
  reduced: 'Fee Reductions',
  scholarship: 'Scholarship Holders',
  expiring: 'Concessions Expiring Soon',
  review: 'Concessions Pending Review',
  revoked: 'Revoked Concessions',
};

async function concessionReport(list, f) {
  if (!CONCESSION_LISTS[list]) throw httpError(404, 'Unknown concession list');
  const items = await concessions.list({ ...f, list });
  return {
    title: CONCESSION_LISTS[list],
    subtitle: `${filterLabel(f)} · ${items.length} record(s) · ${stamp()}`,
    columns: [
      { header: 'Roll No', key: 'rollNumber', width: 14 },
      { header: 'Student', key: 'name', width: 20 },
      { header: 'Program', key: 'program', width: 9 },
      { header: 'Batch', key: 'batch', width: 11 },
      { header: 'Sem', key: 'semester', width: 5 },
      { header: 'Type', key: 'typeName', width: 18 },
      { header: 'Value', key: 'valueLabel', width: 10 },
      { header: 'Fee Heads', key: 'heads', width: 22 },
      { header: 'Coverage', key: 'coverage', width: 22 },
      { header: 'Condition', key: 'condition', width: 11 },
      { header: 'Status', key: 'status', width: 9 },
      { header: 'Reason', key: 'note', width: 28 },
    ],
    rows: items.map((i) => ({
      ...i,
      condition: i.minCgpa != null ? `CGPA ≥ ${i.minCgpa}` : '',
      note: [i.reason, i.reviewNote, i.revokeReason && `Revoked: ${i.revokeReason}`].filter(Boolean).join(' | '),
    })),
  };
}

async function defaulterReport(f) {
  const items = await holds.defaulters(f);
  return {
    title: 'Fee Defaulter List',
    subtitle: `${filterLabel(f)} · ${items.length} student(s) on hold · ${stamp()}`,
    columns: [
      { header: 'Roll No', key: 'rollNumber', width: 14 },
      { header: 'Student', key: 'name', width: 22 },
      { header: 'Program', key: 'program', width: 9 },
      { header: 'Batch', key: 'batch', width: 11 },
      { header: 'Sem', key: 'semester', width: 5 },
      { header: 'Overdue Challans', key: 'overdueChallans', width: 9 },
      { header: 'Outstanding', key: 'outstanding', width: 12, money: true },
      { header: 'Oldest Due', key: 'oldestDue', width: 11 },
      { header: 'Days Overdue', key: 'daysOverdue', width: 8 },
      { header: 'Blocked From', key: 'holds', width: 30 },
    ],
    rows: items,
  };
}

router.get('/reports/:kind', OVERSIGHT, asyncHandler(async (req, res) => {
  res.json(await challanReport(req.params.kind, filtersOf(req.query)));
}));

router.get('/reports/:kind/export', OVERSIGHT, asyncHandler(async (req, res) => {
  await exporter.send(res, await challanReport(req.params.kind, filtersOf(req.query)), req.query.format);
}));

router.get('/concession-lists/:list/export', OVERSIGHT, asyncHandler(async (req, res) => {
  await exporter.send(res, await concessionReport(req.params.list, filtersOf(req.query)), req.query.format);
}));

router.get('/defaulters', OVERSIGHT, asyncHandler(async (req, res) => {
  res.json({ items: await holds.defaulters(filtersOf(req.query)) });
}));

router.get('/defaulters/export', OVERSIGHT, asyncHandler(async (req, res) => {
  await exporter.send(res, await defaulterReport(filtersOf(req.query)), req.query.format);
}));

router.get('/summary', OVERSIGHT, asyncHandler(async (req, res) => {
  await billing.refreshOpenChallans();
  const rows = await prisma.lmsFeeChallan.groupBy({
    by: ['status'], _count: { _all: true }, _sum: { totalAmount: true, paidAmount: true, lateFee: true, discountAmount: true },
  });
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, {
    count: r._count._all,
    payable: round2((r._sum.totalAmount || 0) + (r._sum.lateFee || 0)),
    paid: round2(r._sum.paidAmount || 0),
  }]));
  const [defaulters, active, review, notifications] = await Promise.all([
    holds.defaulters(),
    prisma.feeConcession.count({ where: { status: 'ACTIVE' } }),
    prisma.feeConcession.count({ where: { status: 'REVIEW' } }),
    prisma.feeNotification.count({ where: { status: 'ACTIVE' } }),
  ]);
  res.json({
    byStatus,
    totals: {
      billed: round2(rows.filter((r) => r.status !== 'WAIVED').reduce((s, r) => s + (r._sum.totalAmount || 0) + (r._sum.lateFee || 0), 0)),
      collected: round2(rows.reduce((s, r) => s + (r._sum.paidAmount || 0), 0)),
      concessions: round2(rows.reduce((s, r) => s + (r._sum.discountAmount || 0), 0)),
    },
    defaulters: defaulters.length,
    concessions: { active, review },
    activeNotifications: notifications,
  });
}));

const FEE_ENTITIES = ['BatchFeeStructure', 'FeeHead', 'FeeNotification', 'LmsFeeChallan', 'FeeConcession', 'LmsPaymentMethod', 'ConcessionType'];

router.get('/audit', OVERSIGHT, asyncHandler(async (req, res) => {
  const rows = await prisma.lmsAuditLog.findMany({
    where: { entity: { in: req.query.entity ? [String(req.query.entity)] : FEE_ENTITIES } },
    orderBy: { createdAt: 'desc' },
    take: 300,
    include: { actor: { select: { username: true, role: true, profile: { select: { fullName: true } } } } },
  });
  res.json({
    items: rows.map((r) => ({
      id: r.id, action: r.action, entity: r.entity, entityId: r.entityId, createdAt: r.createdAt,
      actor: r.actor ? (r.actor.profile?.fullName || r.actor.username) : (r.actorRole || 'System'),
      actorRole: r.actor ? r.actor.role : r.actorRole,
      before: safeJson(r.beforeJson, null), after: safeJson(r.afterJson, null),
    })),
  });
}));

// ============================================================
// Student fee account
// ============================================================
router.get('/me', STUDENT, asyncHandler(async (req, res) => {
  const [student, dues, hold, conc, methods, admissionFees] = await Promise.all([
    resolveStudent(req.lmsUser.id),
    billing.studentDues(req.lmsUser.id),
    holds.holdStatus(req.lmsUser.id),
    concessions.list({ studentId: req.lmsUser.id }),
    prisma.lmsPaymentMethod.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    resolveAdmissionFeeEntries(req.lmsUser.id).catch(() => []),
  ]);
  const payments = dues.challans
    .flatMap((c) => c.payments.map((p) => ({ ...p, challanNo: c.challanNo, title: c.title })))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({
    student,
    ...dues,
    payments,
    admissionFees,
    hold,
    methods,
    concessions: conc.filter((c) => c.status !== 'REVOKED').map((c) => ({
      id: c.id, typeName: c.typeName, category: c.category, valueLabel: c.valueLabel,
      heads: c.heads, coverage: c.coverage, reason: c.reason, minCgpa: c.minCgpa, status: c.status,
    })),
  });
}));

// INSTANT methods (online gateway, wallet) confirm at checkout. MANUAL
// methods (bank, counter) are confirmed by Finance when the bank reports.
router.post('/me/challans/:id/pay', STUDENT, validate([
  body('method').isString().notEmpty().withMessage('Select a payment method'),
  body('amount').optional({ values: 'falsy' }).isFloat({ gt: 0 }),
]), asyncHandler(async (req, res) => {
  const method = await prisma.lmsPaymentMethod.findUnique({ where: { code: req.body.method } });
  if (!method || !method.isActive) throw httpError(400, 'Payment method is not available');
  if (method.confirmMode !== 'INSTANT') {
    throw httpError(409, `${method.label}: ${method.instructions || 'the Finance office confirms this payment once received.'}`);
  }
  res.json(fail(await billing.recordPayment({
    req, challanId: parseInt(req.params.id, 10), amount: req.body.amount, method: method.code,
    channel: 'STUDENT', studentId: req.lmsUser.id,
  })));
}));

router.get('/me/hold', STUDENT, asyncHandler(async (req, res) => {
  res.json(await holds.holdStatus(req.lmsUser.id));
}));

module.exports = router;
