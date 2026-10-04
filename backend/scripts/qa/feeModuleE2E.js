// End-to-end check of the Centralized Fee Module against a running backend.
//   node scripts/qa/feeModuleE2E.js [baseUrl]
// Announces a fresh admission cycle for ADCS, so it changes data; run it
// against a development database only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const prisma = require('../../src/utils/prisma');

const BASE = process.argv[2] || 'http://localhost:5000/api';
let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function call(method, url, token, body, { form, raw } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  if (raw) return { status: res.status, type: res.headers.get('content-type'), size: (await res.arrayBuffer()).byteLength };
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}

async function lmsLogin(username, password) {
  const r = await call('POST', '/lms/auth/login', null, { username, password });
  if (!r.data?.token) throw new Error(`LMS login failed for ${username}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function main() {
  const director = (await call('POST', '/auth/login', null, { email: 'director@aust.edu.pk', password: 'director123' })).data.token;
  const provost = await lmsLogin('provost_demo', 'Provost@123');
  if (!process.env.LMS_DEMO_FINANCE_PASSWORD) throw new Error('Set LMS_DEMO_FINANCE_PASSWORD (see README)');
  const finance = await lmsLogin('finance_demo', process.env.LMS_DEMO_FINANCE_PASSWORD);
  const focal = await lmsLogin('focal1', 'Lms@1234');
  const coordinator = await lmsLogin('coord1', 'Lms@1234');

  // ---------- A. Admission announced → structure synced + locked ----------
  const term = `F${String(Date.now()).slice(-2)}`;
  const program = await prisma.program.findFirst({ where: { code: 'ADCS' } });
  const ann = await call('POST', '/admission-cycle/announce', director, {
    title: 'QA Admissions', startDate: daysFromNow(0), endDate: daysFromNow(30), termCode: 'F26',
    programs: [{
      programId: program.id, totalSeats: 50, minMarksPercent: 50,
      feeBreakdown: [
        { label: 'Semester Fee', amount: 26000 },
        { label: 'Admission Fee', amount: 10000 },
        { label: 'Development Fund', amount: 2000 },
      ],
    }],
  });
  check('Director announces admission cycle', ann.status === 201, `HTTP ${ann.status}`);
  await sleep(800);
  let s = await prisma.batchFeeStructure.findUnique({ where: { programCode_batch: { programCode: 'ADCS', batch: 'Fall 2026' } } });
  check('Fee structure synced for ADCS – Fall 2026', !!s, s ? `semester fee ${s.semesterFee}` : 'missing');
  check('Semester fee snapshot locked at 26,000', s?.semesterFee === 26000);
  const syncAudit = await prisma.lmsAuditLog.findFirst({ where: { entity: 'BatchFeeStructure', entityId: String(s?.id) } });
  check('Structure sync is audit-logged', !!syncAudit, syncAudit?.actorRole);

  // A later cycle with a higher fee must not move the locked snapshot.
  await call('POST', '/admission-cycle/announce', director, {
    title: 'QA Re-announce', startDate: daysFromNow(0), endDate: daysFromNow(30), termCode: 'F26',
    programs: [{ programId: program.id, feeBreakdown: [{ label: 'Semester Fee', amount: 31000 }, { label: 'Development Fund', amount: 2500 }] }],
  });
  await sleep(800);
  s = await prisma.batchFeeStructure.findUnique({ where: { id: s.id } });
  const dev = JSON.parse(s.items).find((i) => i.name === 'Development Fund');
  check('Re-sync keeps locked semester fee at 26,000', s.semesterFee === 26000, `now ${s.semesterFee}`);
  check('Re-sync updates revisable Development Fund', dev?.amount === 2500, `now ${dev?.amount}`);

  const config = (await call('GET', '/lms/academic/fees/config', provost)).data;
  const head = (n) => config.heads.find((h) => h.name === n);
  const lockedEdit = await call('PUT', `/lms/academic/fees/structures/${s.id}/items/${head('Semester Fee').id}`, finance, { amount: 1 });
  check('Locked semester fee cannot be edited', lockedEdit.status === 409, lockedEdit.data?.error);

  // ---------- B. Provost notification → challans ----------
  const students = (await call('GET', '/lms/academic/fees/students?program=ADCS&batch=Fall%202026', provost)).data.items;
  const sem1 = students.filter((p) => p.semester === 1);
  check('ADCS Fall 2026 semester-1 students found', sem1.length >= 2, `${sem1.length} students`);
  const [alice, bob] = sem1;

  const notif = await call('POST', '/lms/academic/fees/notifications', provost, {
    title: `QA Semester 1 Dues ${term}`, programs: ['ADCS'], batches: ['Fall 2026'], semesters: [1],
    items: [{ headId: head('Examination Fee').id, name: 'Examination Fee', amount: 3000 }],
    dueDate: daysFromNow(10), lateFeeType: 'PER_DAY', lateFeeAmount: 100,
  });
  check('Provost announces fee notification', notif.status === 201, `HTTP ${notif.status} ${notif.data?.error || ''}`);
  const nid = notif.data.notification.id;
  check('Challans generated for every targeted student', notif.data.generated === sem1.length, `${notif.data.generated}/${sem1.length}`);

  const forbidden = await call('POST', '/lms/academic/fees/notifications', finance, { title: 'x' });
  check('Finance cannot announce notifications', forbidden.status === 403);

  const detail = (await call('GET', `/lms/academic/fees/notifications/${nid}`, provost)).data;
  const aliceChallan = detail.challans.find((c) => c.studentId === alice.studentId);
  const lines = Object.fromEntries(aliceChallan.lineItems.map((l) => [l.label, l.amount]));
  check('Semester 1 challan = 26,000 + 10,000 + 2,500 + 3,000', aliceChallan.totalAmount === 41500, JSON.stringify(lines));
  check('Live status reported to Provost', detail.notification.progress.challans === sem1.length);

  const studentToken = await lmsLogin(alice.rollNumber, 'Lms@1234').catch(() => null);
  if (studentToken) {
    const me = (await call('GET', '/lms/academic/fees/me', studentToken)).data;
    check('Student sees challan in fee view', me.challans.some((c) => c.id === aliceChallan.id), `remaining ${me.summary.remaining}`);
    const notes = await prisma.lmsNotification.count({ where: { userId: alice.studentId, title: 'New fee challan' } });
    check('Student notified of new challan', notes > 0);

    // ---------- Payments ----------
    const manual = await call('POST', `/lms/academic/fees/me/challans/${aliceChallan.id}/pay`, studentToken, { method: 'BANK' });
    check('Bank deposits wait for Finance confirmation', manual.status === 409);
    const partial = await call('POST', `/lms/academic/fees/me/challans/${aliceChallan.id}/pay`, studentToken, { method: 'ONLINE', amount: 20000 });
    check('Online partial payment confirmed instantly', partial.data?.challan?.status === 'PARTIAL', partial.data?.challan?.status);
    const rest = await call('POST', `/lms/academic/fees/challans/${aliceChallan.id}/payments`, finance, { method: 'BANK', reference: `NBP-${term}-${aliceChallan.id}` });
    check('Finance confirms bank deposit → PAID', rest.data?.challan?.status === 'PAID', rest.data?.challan?.status);
    const meAfter = (await call('GET', '/lms/academic/fees/me', studentToken)).data;
    check('Student payment history shows 2 payments', meAfter.payments.filter((p) => p.challanNo === aliceChallan.challanNo).length === 2);
  } else {
    check('Student login', false, alice.rollNumber);
  }

  // ---------- C. Concession ----------
  await prisma.feeConcession.updateMany({ where: { studentId: bob.studentId, status: { in: ['ACTIVE', 'REVIEW'] } }, data: { status: 'REVOKED', revokeReason: 'QA reset' } });
  const proof = path.join(os.tmpdir(), 'qa-proof.pdf');
  fs.writeFileSync(proof, '%PDF-1.4\n%QA proof\n');
  const form = new FormData();
  form.append('studentId', bob.studentId);
  form.append('typeId', String(config.concessionTypes.find((t) => t.name === 'Merit Scholarship').id));
  form.append('mode', 'PERCENT');
  form.append('value', '50');
  form.append('headIds', JSON.stringify([head('Semester Fee').id]));
  form.append('durationType', 'UNTIL_LAST');
  form.append('minCgpa', '3.0');
  form.append('reason', 'Top merit position in the entry test');
  const noProof = new FormData();
  for (const [k, v] of form.entries()) noProof.append(k, v);
  const rejected = await call('POST', '/lms/academic/fees/concessions', provost, undefined, { form: noProof });
  check('Concession without proof is rejected', rejected.status === 400, rejected.data?.error);
  form.append('proof', new Blob([fs.readFileSync(proof)], { type: 'application/pdf' }), 'proof.pdf');
  const conc = await call('POST', '/lms/academic/fees/concessions', provost, undefined, { form });
  check('Provost applies 50% semester-fee scholarship', conc.status === 201, conc.data?.error);

  const notif2 = await call('POST', '/lms/academic/fees/notifications', provost, {
    title: `QA Supplementary ${term}`, programs: ['ADCS'], batches: ['Fall 2026'], semesters: [1],
    dueDate: daysFromNow(-3), lateFeeType: 'FLAT', lateFeeAmount: 500,
  });
  const bobChallan = (await call('GET', `/lms/academic/fees/notifications/${notif2.data.notification.id}`, provost)).data
    .challans.find((c) => c.studentId === bob.studentId);
  const semLine = bobChallan.lineItems.find((l) => l.label === 'Semester Fee');
  check('Next challan reflects concession on Semester Fee only', semLine.concession === 13000 && bobChallan.discountAmount === 13000,
    `semester ${semLine.amount} − ${semLine.concession}, total ${bobChallan.totalAmount}`);
  check('Past-due challan is OVERDUE with flat late fee', bobChallan.status === 'OVERDUE' && bobChallan.lateFee === 500, `${bobChallan.status} late ${bobChallan.lateFee}`);

  const trail = (await call('GET', `/lms/academic/fees/concessions/${conc.data.concession.id}/trail`, provost)).data.items;
  check('Concession trail records the apply', trail.some((t) => t.action === 'CONCESSION_APPLY'));
  const rev = await call('PUT', `/lms/academic/fees/concessions/${conc.data.concession.id}`, provost, { value: 40, reason: 'Revised per scholarship committee' });
  check('Concession revised', rev.status === 200 && rev.data.concession.value === 40);
  const dup = await call('POST', `/lms/academic/fees/challans/${aliceChallan.id}/payments`, finance, { method: 'BANK', reference: `NBP-${term}-${aliceChallan.id}` });
  check('Paid challan / reused reference rejected', dup.status === 409, dup.data?.error);

  // ---------- D. Dues holds ----------
  const bobToken = await lmsLogin(bob.rollNumber, 'Lms@1234');
  const admit = (await call('GET', '/lms/academic/student/admit-card', bobToken)).data;
  check('Defaulter blocked from admit card', admit.hold.onHold && !admit.eligible, admit.hold.message);
  const admitPdf = await call('GET', '/lms/academic/student/admit-card/pdf', bobToken, undefined, { raw: true });
  check('Admit card PDF refused with 402', admitPdf.status === 402);
  const enrol = (await call('POST', '/lms/academic/student/auto-enroll', bobToken)).data;
  check('Defaulter blocked from course registration', enrol.reason === 'fee-hold', enrol.reason);
  const promos = (await call('GET', '/lms/academic/focal/promotions', focal)).data.promotions;
  const bobPromo = promos.find((p) => p.studentId === bob.studentId);
  check('Promotion shows Hold for defaulter', !bobPromo || bobPromo.status === 'Hold', bobPromo ? bobPromo.status : 'no published results (not listed)');

  const defaulters = (await call('GET', '/lms/academic/fees/defaulters?program=ADCS', focal)).data.items;
  check('Defaulter list (Focal Person) includes the student', defaulters.some((d) => d.studentId === bob.studentId));
  const provDef = (await call('GET', '/lms/academic/fees/defaulters', provost)).data.items;
  check('Defaulter list (Provost) includes the student', provDef.some((d) => d.studentId === bob.studentId));
  // Clear every overdue challan Bob has (including seeded history) through
  // Finance; the hold must lift as soon as the last one is paid.
  const open = (await call('GET', `/lms/academic/fees/students/${bob.studentId}`, finance)).data.challans.filter((c) => c.status === 'OVERDUE');
  for (const c of open) await call('POST', `/lms/academic/fees/challans/${c.id}/payments`, finance, { method: 'CHALLAN', reference: `CTR-${c.id}-${term}` });
  const cleared = (await call('GET', '/lms/academic/fees/me/hold', bobToken)).data;
  check(`Paying ${open.length} overdue challan(s) lifts the hold`, !cleared.onHold, cleared.message || '');
  const admitOk = (await call('GET', '/lms/academic/student/admit-card', bobToken)).data;
  check('Admit card available again after clearing dues', !admitOk.hold.onHold);

  // ---------- Charges ----------
  const freeze = await call('POST', '/lms/academic/fees/charges/freeze', finance, { studentId: bob.studentId, mode: 'FREEZE' });
  check('Frozen semester = 25% of locked 26,000', freeze.data?.challan?.totalAmount === 6500, `${freeze.data?.challan?.totalAmount}`);
  const resit = await call('POST', '/lms/academic/fees/charges/resit', finance, { studentId: bob.studentId, courses: ['CS-101', 'MTH-101'] });
  check('Resit = Rs 2,000 × 2 courses', resit.data?.challan?.totalAmount === 4000);
  const special = await call('POST', '/lms/academic/fees/charges/special-semester', coordinator, { studentIds: [bob.studentId], amount: 15000 });
  check('Coordinator sets special-semester fee', special.data?.created === 1);
  const late = await call('POST', '/lms/academic/fees/charges/late-registration', coordinator, { studentId: bob.studentId });
  check('Late registration challan', late.status === 201);
  const appeal = await call('POST', '/lms/academic/student/appeals', bobToken, {
    subject: 'Missed mid-term due to illness', description: 'Medical certificate attached later', caseType: 'APPEAL', category: 'ABSENCE_APPEAL',
  });
  const absence = await prisma.lmsFeeChallan.findFirst({ where: { studentId: bob.studentId, kind: 'ABSENCE_APPEAL' } });
  check('Absence appeal auto-raises Rs 1,000 challan', appeal.status === 201 && absence?.totalAmount === 1000, `appeal HTTP ${appeal.status}`);

  const revoke = await call('POST', `/lms/academic/fees/concessions/${conc.data.concession.id}/revoke`, provost, { reason: 'QA run finished' });
  const revoked = (await call('GET', '/lms/academic/fees/concessions?list=revoked', provost)).data.items;
  check('Revoked concession appears in Revoked list', revoke.status === 200 && revoked.some((c) => c.id === conc.data.concession.id));
  const notified = await prisma.lmsNotification.count({ where: { userId: bob.studentId, title: { in: ['Fee concession applied', 'Fee concession revised', 'Fee concession removed'] } } });
  check('Student notified of concession apply / revise / remove', notified >= 3);

  // ---------- Exports ----------
  for (const [label, url] of [
    ['Paid report Excel', '/lms/academic/fees/reports/paid/export?format=xlsx'],
    ['Overdue report PDF', '/lms/academic/fees/reports/overdue/export?format=pdf'],
    ['Scholarship list Excel', '/lms/academic/fees/concession-lists/scholarship/export?format=xlsx'],
    ['Revoked list PDF', '/lms/academic/fees/concession-lists/revoked/export?format=pdf'],
    ['Defaulter list PDF', '/lms/academic/fees/defaulters/export?format=pdf&program=ADCS'],
  ]) {
    const r = await call('GET', url, provost, undefined, { raw: true });
    check(`Export: ${label}`, r.status === 200 && r.size > 500, `${r.status} ${r.type} ${r.size}B`);
  }
  const studentReport = await call('GET', '/lms/academic/fees/reports/paid', bobToken);
  check('Students cannot read fee reports', studentReport.status === 403);

  const auditCount = await prisma.lmsAuditLog.count({ where: { action: { in: ['FEE_PAYMENT_CONFIRMED', 'CONCESSION_REVISE', 'FEE_NOTIFICATION_ANNOUNCE'] } } });
  check('Payment, concession and notification actions audited', auditCount >= 4, `${auditCount} rows`);

  console.log(`\n${failures ? `${failures} check(s) failed` : 'All checks passed'}`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
