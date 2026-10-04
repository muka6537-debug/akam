// Challans, concessions, payments, late fees and dues.
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { safeJson } = require('../utils/lmsHelpers');
const { audit } = require('../utils/lmsAudit');
const { notify } = require('../utils/lmsNotify');
const realtime = require('../utils/lmsRealtime');
const { structureFor, semesterDues, headByName } = require('./feeStructure');
const { resolveStudents, resolveStudent } = require('./feeStudents');

const OPEN_STATUSES = ['UNPAID', 'PARTIAL', 'OVERDUE'];
const SYSTEM = { role: 'System' };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-PK')}`;
const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);
const endOfDay = (date) => new Date(`${date}T23:59:59`);

const DEFAULT_METHODS = [
  { code: 'ONLINE', label: 'Online (Bank Gateway)', confirmMode: 'INSTANT', sortOrder: 1, instructions: 'Pay securely through the bank payment gateway.' },
  { code: 'WALLET', label: 'Mobile Wallet', confirmMode: 'INSTANT', sortOrder: 2, instructions: 'Pay from your mobile wallet account.' },
  { code: 'BANK', label: 'Bank Deposit', confirmMode: 'MANUAL', sortOrder: 3, instructions: 'Deposit at any partner bank branch quoting the challan number. Finance confirms the deposit.' },
  { code: 'CHALLAN', label: 'Challan (Over the Counter)', confirmMode: 'MANUAL', sortOrder: 4, instructions: 'Download the challan and pay at the counter. Finance confirms the payment.' },
];

const DEFAULT_CONCESSION_TYPES = [
  { name: 'Full Waiver', category: 'WAIVER' },
  { name: 'Fee Reduction', category: 'REDUCTION' },
  { name: 'Need-based Scholarship', category: 'SCHOLARSHIP' },
  { name: 'Merit Scholarship', category: 'SCHOLARSHIP' },
];

// Fixed amounts for system charges.
const CHARGE_RATES = { RESIT_PER_COURSE: 2000, ABSENCE_APPEAL: 1000, LATE_REGISTRATION: 1500, FREEZE_SHARE: 0.25 };

async function ensureDefaults() {
  for (const m of DEFAULT_METHODS) await prisma.lmsPaymentMethod.upsert({ where: { code: m.code }, update: {}, create: m });
  for (const t of DEFAULT_CONCESSION_TYPES) await prisma.concessionType.upsert({ where: { name: t.name }, update: {}, create: t });
}

const newChallanNo = (prefix = 'CH') => `${prefix}-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

// ------------------------------------------------------------
// Late fee + status
// ------------------------------------------------------------
function lateFeeFor(challan, notification, on = new Date()) {
  if (!notification || notification.lateFeeType === 'NONE' || !challan.dueDate) return 0;
  const due = endOfDay(challan.dueDate);
  if (on <= due) return 0;
  if (notification.lateFeeType === 'FLAT') return round2(notification.lateFeeAmount);
  return round2(Math.ceil((on - due) / 86400000) * notification.lateFeeAmount);
}

function statusFor(c) {
  if (c.status === 'WAIVED') return 'WAIVED';
  const payable = round2(c.totalAmount + (c.lateFee || 0));
  if (payable <= 0) return 'WAIVED';
  if (c.paidAmount >= payable - 0.005) return 'PAID';
  if (c.dueDate && endOfDay(c.dueDate) < new Date()) return 'OVERDUE';
  return c.paidAmount > 0 ? 'PARTIAL' : 'UNPAID';
}

function shapeChallan(c) {
  const payable = round2(c.totalAmount + (c.lateFee || 0));
  return {
    id: c.id,
    challanNo: c.challanNo,
    title: c.title,
    kind: c.kind || 'NOTIFICATION',
    lineItems: safeJson(c.lineItems, []),
    grossAmount: c.grossAmount || c.totalAmount,
    discountAmount: c.discountAmount || 0,
    totalAmount: c.totalAmount,
    lateFee: c.lateFee || 0,
    payable,
    paidAmount: c.paidAmount || 0,
    remaining: Math.max(0, round2(payable - (c.paidAmount || 0))),
    status: c.status,
    dueDate: c.dueDate,
    paidAt: c.paidAt,
    paymentRef: c.paymentRef,
    studentId: c.studentId,
    program: c.program,
    batch: c.batch,
    semester: c.semester,
    notificationId: c.notificationId,
    description: c.description,
    createdAt: c.createdAt,
    payments: (c.payments || []).map((p) => ({
      id: p.id, amount: p.amount, method: p.method, reference: p.reference, channel: p.channel, note: p.note, createdAt: p.createdAt,
    })),
  };
}

// Re-evaluate late fee + status of open challans so every read reports
// current dues. Late-fee changes are audited; overdue is notified once.
async function refreshOpenChallans(where = {}) {
  const open = await prisma.lmsFeeChallan.findMany({ where: { ...where, status: { in: OPEN_STATUSES } } });
  if (!open.length) return 0;
  const notifIds = [...new Set(open.map((c) => c.notificationId).filter(Boolean))];
  const notifs = new Map((notifIds.length
    ? await prisma.feeNotification.findMany({ where: { id: { in: notifIds } } }) : []).map((n) => [n.id, n]));
  let changed = 0;
  for (const c of open) {
    const lateFee = lateFeeFor(c, notifs.get(c.notificationId));
    const status = statusFor({ ...c, lateFee });
    if (lateFee === (c.lateFee || 0) && status === c.status) continue;
    const data = { lateFee, status };
    if (status === 'OVERDUE' && !c.overdueNotifiedAt) data.overdueNotifiedAt = new Date();
    await prisma.lmsFeeChallan.update({ where: { id: c.id }, data });
    if (lateFee !== (c.lateFee || 0)) {
      await audit(null, 'FEE_LATE_FEE_APPLIED', 'LmsFeeChallan', c.id, {
        before: { lateFee: c.lateFee || 0, status: c.status }, after: { lateFee, status }, actor: SYSTEM,
      });
    }
    if (data.overdueNotifiedAt) {
      await notify(c.studentId, {
        title: 'Fee overdue',
        message: `${c.title} (${c.challanNo}) is past its due date.${lateFee ? ` A late fee of ${money(lateFee)} now applies.` : ''} Course registration, admit card and promotion stay on hold until it is paid.`,
        type: 'FEE', link: '/student/account',
      });
    }
    changed += 1;
  }
  return changed;
}

// Remind students three days before the due date (once per challan).
async function sendDeadlineReminders() {
  const soon = isoDate(new Date(Date.now() + 3 * 86400000));
  const due = await prisma.lmsFeeChallan.findMany({
    where: { status: { in: ['UNPAID', 'PARTIAL'] }, reminderSentAt: null, dueDate: { gte: isoDate(), lte: soon } },
  });
  for (const c of due) {
    const n = c.notificationId ? await prisma.feeNotification.findUnique({ where: { id: c.notificationId } }) : null;
    const late = n && n.lateFeeType !== 'NONE'
      ? ` A late fee of ${money(n.lateFeeAmount)}${n.lateFeeType === 'PER_DAY' ? ' per day' : ''} applies after the deadline.` : '';
    await notify(c.studentId, {
      title: 'Fee deadline approaching',
      message: `${c.title} (${c.challanNo}) is due on ${c.dueDate}.${late}`,
      type: 'FEE', link: '/student/account',
    });
    await prisma.lmsFeeChallan.update({ where: { id: c.id }, data: { reminderSentAt: new Date() } });
  }
  return due.length;
}

// ------------------------------------------------------------
// Concessions applied to line items
// ------------------------------------------------------------
function concessionCovers(c, semester) {
  if (c.status !== 'ACTIVE' || semester == null || semester < c.startSemester) return false;
  return c.endSemester == null || semester <= c.endSemester;
}

// Each concession discounts only its selected heads; percentages apply
// per line, flat amounts are spread across the selected lines in order.
function applyConcessions(lines, concessions, semester) {
  const out = lines.map((l) => ({ ...l, concession: 0, concessionIds: [] }));
  for (const c of concessions.filter((x) => concessionCovers(x, semester))) {
    const heads = safeJson(c.headIds, []);
    let left = c.value;
    for (const l of out.filter((x) => x.headId && heads.includes(x.headId))) {
      const room = l.amount - l.concession;
      const off = round2(c.mode === 'PERCENT' ? Math.min(room, (l.amount * c.value) / 100) : Math.min(left, room));
      if (off <= 0) continue;
      l.concession = round2(l.concession + off);
      l.concessionIds.push(c.id);
      if (c.mode !== 'PERCENT') { left -= off; if (left <= 0) break; }
    }
  }
  return out.map((l) => ({ ...l, net: round2(l.amount - l.concession) }));
}

// ------------------------------------------------------------
// Challan creation
// ------------------------------------------------------------
async function currentTermId() {
  const t = await prisma.academicTerm.findFirst({ where: { isCurrent: true } })
    || await prisma.academicTerm.findFirst({ orderBy: { id: 'desc' } });
  return t ? t.id : null;
}

async function createChallan({ student, title, kind, lines, dueDate, notificationId, description, prefix }) {
  const concessions = await prisma.feeConcession.findMany({ where: { studentId: student.studentId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  const priced = applyConcessions(lines, concessions, student.semester);
  const gross = round2(priced.reduce((s, l) => s + l.amount, 0));
  const discount = round2(priced.reduce((s, l) => s + l.concession, 0));
  const total = round2(gross - discount);
  const challan = await prisma.lmsFeeChallan.create({
    data: {
      studentId: student.studentId,
      termId: await currentTermId(),
      challanNo: newChallanNo(prefix),
      title,
      kind,
      lineItems: JSON.stringify(priced),
      grossAmount: gross,
      discountAmount: discount,
      totalAmount: total,
      dueDate: dueDate || null,
      status: total <= 0 ? 'WAIVED' : 'UNPAID',
      program: student.program || null,
      batch: student.batch || null,
      department: student.department || null,
      semester: student.semester,
      description: description || null,
      notificationId: notificationId || null,
    },
  });
  await audit(null, 'FEE_CHALLAN_GENERATE', 'LmsFeeChallan', challan.id, {
    after: { studentId: student.studentId, challanNo: challan.challanNo, kind, gross, discount, total, lines: priced }, actor: SYSTEM,
  });
  return challan;
}

function notificationTargets(n) {
  return {
    programs: safeJson(n.programs, []),
    batches: safeJson(n.batches, []),
    semesters: safeJson(n.semesters, []).map(Number),
  };
}

const inScope = (pos, t) => (!t.programs.length || t.programs.includes(pos.program))
  && (!t.batches.length || t.batches.includes(pos.batch))
  && (!t.semesters.length || t.semesters.includes(Number(pos.semester)));

// Generate each targeted student's challan for a notification: their own
// batch's semester dues (locked semester fee + applicable heads), the
// notified heads, less their concessions. Idempotent per student.
async function generateForNotification(notification) {
  const t = notificationTargets(notification);
  const positions = [...(await resolveStudents()).values()].filter((p) => p.isActive && inScope(p, t));
  const already = new Set((await prisma.lmsFeeChallan.findMany({
    where: { notificationId: notification.id }, select: { studentId: true },
  })).map((c) => c.studentId));
  const extra = safeJson(notification.items, []);
  const skipped = [];
  let generated = 0;

  for (const pos of positions) {
    if (already.has(pos.studentId)) continue;
    const lines = [];
    if (notification.includeSemesterDues) {
      const structure = await structureFor(pos.program, pos.batch);
      if (!structure) {
        skipped.push({ studentId: pos.studentId, roll: pos.rollNumber, reason: `No fee structure synced for ${pos.program} – ${pos.batch || 'unknown batch'}` });
        continue;
      }
      lines.push(...semesterDues(structure, pos.semester));
    }
    for (const i of extra) {
      if (Number(i.amount) > 0) lines.push({ headId: i.headId || null, label: i.name, category: 'NOTIFIED', amount: Number(i.amount) });
    }
    if (!lines.length) {
      skipped.push({ studentId: pos.studentId, roll: pos.rollNumber, reason: 'Nothing payable for this student' });
      continue;
    }
    const challan = await createChallan({
      student: pos, title: notification.title, kind: 'NOTIFICATION', lines,
      dueDate: notification.dueDate, notificationId: notification.id, description: notification.description,
    });
    generated += 1;
    await notify(pos.studentId, {
      title: 'New fee challan',
      message: `${notification.title}: ${money(challan.totalAmount)} due by ${notification.dueDate}. Challan ${challan.challanNo} is in your Fee Account.`,
      type: 'FEE', link: '/student/account',
    });
    realtime.emitTo([pos.studentId], 'fee:challan', { id: challan.id });
  }

  await prisma.feeNotification.update({
    where: { id: notification.id },
    data: { targetedCount: positions.length, generatedCount: already.size + generated, skippedJson: JSON.stringify(skipped) },
  });
  return { targeted: positions.length, generated, skipped };
}

// One-off charge challan (freeze, resit, special semester, late
// registration, absence appeal).
async function raiseCharge({ req, studentId, kind, headName, amount, title, description, dueInDays = 14 }) {
  const student = await resolveStudent(studentId);
  if (!student) return { error: 'Student not found', status: 404 };
  const head = await headByName(headName);
  const dueDate = isoDate(new Date(Date.now() + dueInDays * 86400000));
  const challan = await createChallan({
    student, title, kind, dueDate, description, prefix: kind.slice(0, 3),
    lines: [{ headId: head ? head.id : null, label: headName, category: 'CHARGE', amount: round2(amount) }],
  });
  await audit(req, `FEE_CHARGE_${kind}`, 'LmsFeeChallan', challan.id, {
    after: { studentId, kind, amount: challan.totalAmount, challanNo: challan.challanNo, description },
  });
  await notify(studentId, {
    title: 'New fee challan',
    message: `${title}: ${money(challan.totalAmount)} due by ${dueDate} (${challan.challanNo}).`,
    type: 'FEE', link: '/student/account',
  });
  realtime.emitTo([studentId], 'fee:challan', { id: challan.id });
  return { challan: shapeChallan(challan) };
}

// ------------------------------------------------------------
// Payments — the single confirmation path for every channel.
// ------------------------------------------------------------
async function recordPayment({ req, challanId, amount, method, channel, reference, note, studentId }) {
  const challan = await prisma.lmsFeeChallan.findUnique({ where: { id: challanId } });
  if (!challan || (studentId && challan.studentId !== studentId)) return { error: 'Fee challan not found', status: 404 };
  if (!OPEN_STATUSES.includes(challan.status)) return { error: `This challan is already ${challan.status.toLowerCase()}.`, status: 409 };
  const m = await prisma.lmsPaymentMethod.findUnique({ where: { code: method } });
  if (!m || !m.isActive) return { error: 'Payment method is not available', status: 400 };
  if (reference && await prisma.lmsFeePayment.findUnique({ where: { reference } })) {
    return { error: `Reference ${reference} has already been used for another payment`, status: 409 };
  }

  const n = challan.notificationId ? await prisma.feeNotification.findUnique({ where: { id: challan.notificationId } }) : null;
  const lateFee = lateFeeFor(challan, n);
  const remaining = round2(challan.totalAmount + lateFee - challan.paidAmount);
  const pay = round2(amount == null || amount === '' ? remaining : Math.min(Number(amount), remaining));
  if (!(pay > 0)) return { error: 'Payment amount must be greater than zero', status: 400 };

  const payment = await prisma.lmsFeePayment.create({
    data: {
      challanId, studentId: challan.studentId, amount: pay, method, channel,
      reference: reference || `PAY-${Date.now().toString(36).toUpperCase()}-${challanId}`,
      recordedById: req?.lmsUser?.id || null, note: note || null,
    },
  });
  const paidAmount = round2(challan.paidAmount + pay);
  const status = statusFor({ ...challan, lateFee, paidAmount });
  const updated = await prisma.lmsFeeChallan.update({
    where: { id: challanId },
    data: { paidAmount, lateFee, status, paidAt: status === 'PAID' ? new Date() : challan.paidAt, paymentRef: payment.reference },
    include: { payments: true },
  });
  await audit(req, 'FEE_PAYMENT_CONFIRMED', 'LmsFeeChallan', challanId, {
    before: { status: challan.status, paidAmount: challan.paidAmount, lateFee: challan.lateFee },
    after: { status, paidAmount, lateFee, payment: { amount: pay, method, channel, reference: payment.reference } },
  });
  await notify(challan.studentId, {
    title: status === 'PAID' ? 'Payment confirmed' : 'Partial payment received',
    message: `${money(pay)} received for ${challan.title} (${challan.challanNo}) via ${m.label}.${status === 'PAID' ? ' The challan is fully paid.' : ` Remaining: ${money(remaining - pay)}.`}`,
    type: 'FEE', link: '/student/account',
  });
  realtime.emitTo([challan.studentId], 'fee:paid', { id: challanId, status });
  return { challan: shapeChallan(updated), payment };
}

// ------------------------------------------------------------
// Dues
// ------------------------------------------------------------
async function studentDues(studentId) {
  await refreshOpenChallans({ studentId });
  const challans = (await prisma.lmsFeeChallan.findMany({
    where: { studentId }, include: { payments: { orderBy: { createdAt: 'desc' } } }, orderBy: { createdAt: 'desc' },
  })).map(shapeChallan);
  const open = challans.filter((c) => OPEN_STATUSES.includes(c.status));
  return {
    challans,
    summary: {
      totalDue: round2(challans.filter((c) => c.status !== 'WAIVED').reduce((s, c) => s + c.payable, 0)),
      paid: round2(challans.reduce((s, c) => s + c.paidAmount, 0)),
      remaining: round2(open.reduce((s, c) => s + c.remaining, 0)),
      concessions: round2(challans.reduce((s, c) => s + c.discountAmount, 0)),
      deadline: open.map((c) => c.dueDate).filter(Boolean).sort()[0] || null,
      overdue: open.some((c) => c.status === 'OVERDUE'),
    },
  };
}

// Unpaid dues = any challan past its due date and not fully paid.
// Challans still within their payment window do not block a student.
async function overdueChallans(studentIds) {
  const where = studentIds ? { studentId: { in: studentIds } } : {};
  await refreshOpenChallans(where);
  return prisma.lmsFeeChallan.findMany({ where: { ...where, status: 'OVERDUE' } });
}

module.exports = {
  OPEN_STATUSES, CHARGE_RATES, round2, money, ensureDefaults, shapeChallan, lateFeeFor,
  refreshOpenChallans, sendDeadlineReminders, applyConcessions,
  generateForNotification, raiseCharge, recordPayment, studentDues, overdueChallans,
};
