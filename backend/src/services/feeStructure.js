// Fee heads and Program + Batch fee structures.
//
// When the Director Admissions announces a cycle, each program's fee
// breakdown is synced into a BatchFeeStructure. The semester fee is
// snapshotted at that moment and never rewritten — every student of the
// batch pays the same amount until their last semester. The only way to
// change what an individual pays is a Provost concession.
const prisma = require('../utils/prisma');
const { safeJson } = require('../utils/lmsHelpers');
const { audit } = require('../utils/lmsAudit');
const { feeEvents, ADMISSION_ANNOUNCED } = require('../utils/feeEvents');

const DEFAULT_HEADS = [
  { name: 'Semester Fee', category: 'SEMESTER', isRecurring: true, isLocked: true, sortOrder: 1 },
  { name: 'Admission Fee', category: 'ONE_TIME', isRecurring: false, isLocked: true, sortOrder: 2 },
  { name: 'Registration Fee', category: 'ONE_TIME', isRecurring: false, isLocked: true, sortOrder: 3 },
  { name: 'Security Fee', category: 'ONE_TIME', isRecurring: false, isLocked: true, sortOrder: 4 },
  { name: 'Development Fund', category: 'OTHER', isRecurring: true, isLocked: false, sortOrder: 5 },
  { name: 'Examination Fee', category: 'OTHER', isRecurring: true, isLocked: true, sortOrder: 6 },
  { name: 'Library Fee', category: 'OTHER', isRecurring: true, isLocked: false, sortOrder: 7 },
  { name: 'Freeze Fee', category: 'CHARGE', isRecurring: false, isLocked: true, sortOrder: 20 },
  { name: 'Resit Fee', category: 'CHARGE', isRecurring: false, isLocked: true, sortOrder: 21 },
  { name: 'Special Semester Fee', category: 'CHARGE', isRecurring: false, isLocked: false, sortOrder: 22 },
  { name: 'Late Registration Fee', category: 'CHARGE', isRecurring: false, isLocked: false, sortOrder: 23 },
  { name: 'Absence Appeal Fee', category: 'CHARGE', isRecurring: false, isLocked: true, sortOrder: 24 },
];

// Labels the Director commonly types that mean an existing head.
const HEAD_ALIASES = { 'tuition fee': 'Semester Fee', tuition: 'Semester Fee', 'semester tuition': 'Semester Fee' };
const SEASONS = { F: 'Fall', S: 'Spring', U: 'Summer', W: 'Winter' };

// "Fall 2026 Admissions" / "F26" / "fall-2026" → "Fall 2026".
function batchLabel(value) {
  const s = String(value || '').trim();
  const named = s.match(/(fall|spring|summer|winter)\D*(\d{4})/i);
  if (named) return `${named[1][0].toUpperCase()}${named[1].slice(1).toLowerCase()} ${named[2]}`;
  const code = s.match(/^([FSUW])(\d{2})$/i);
  if (code) return `${SEASONS[code[1].toUpperCase()]} 20${code[2]}`;
  return s;
}

async function ensureDefaultHeads() {
  for (const h of DEFAULT_HEADS) {
    await prisma.feeHead.upsert({ where: { name: h.name }, update: {}, create: h });
  }
}

async function listHeads({ includeInactive = false } = {}) {
  return prisma.feeHead.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

const headByName = (name) => prisma.feeHead.findUnique({ where: { name } });

async function resolveHead(label) {
  const clean = String(label || '').trim();
  const canonical = HEAD_ALIASES[clean.toLowerCase()] || clean;
  const heads = await prisma.feeHead.findMany();
  const found = heads.find((h) => h.name.toLowerCase() === canonical.toLowerCase());
  if (found) return { head: found, created: false };
  // Unknown labels become one-time "Other" heads until Finance classifies
  // them, so a new label can never over-bill later semesters.
  const head = await prisma.feeHead.create({
    data: { name: canonical, category: 'OTHER', isRecurring: false, isLocked: false, sortOrder: 50 },
  });
  return { head, created: true };
}

function itemFromHead(head, amount) {
  const fixed = head.category === 'SEMESTER' || head.category === 'ONE_TIME';
  return {
    headId: head.id,
    name: head.name,
    category: head.category,
    isRecurring: fixed ? head.category === 'SEMESTER' : head.isRecurring,
    isLocked: fixed ? true : head.isLocked,
    amount: Number(amount) || 0,
  };
}

const shapeStructure = (s) => ({ ...s, items: safeJson(s.items, []) });

async function syncProgramStructure({ cycle, program, breakdown, actor }) {
  const batch = batchLabel(cycle.termCode || cycle.title);
  const programCode = program.shortForm || program.code;
  const incoming = [];
  const createdHeads = [];
  for (const li of breakdown) {
    const { head, created } = await resolveHead(li.label);
    if (created) createdHeads.push(head.name);
    const existing = incoming.find((i) => i.headId === head.id);
    if (existing) existing.amount += Number(li.amount) || 0;
    else incoming.push(itemFromHead(head, li.amount));
  }

  const current = await prisma.batchFeeStructure.findUnique({
    where: { programCode_batch: { programCode, batch } },
  });

  if (!current) {
    const semesterFee = incoming.filter((i) => i.category === 'SEMESTER').reduce((s, i) => s + i.amount, 0);
    const created = await prisma.batchFeeStructure.create({
      data: {
        programCode, programName: program.name, batch, admissionCycleId: cycle.id,
        semesterFee, items: JSON.stringify(incoming), syncedBy: actor?.label || null,
      },
    });
    await audit(null, 'FEE_STRUCTURE_SYNC', 'BatchFeeStructure', created.id, {
      after: { programCode, batch, semesterFee, items: incoming, lockedSnapshot: true }, actor,
    });
    return { structure: shapeStructure(created), created: true, createdHeads };
  }

  // Existing batch: the locked snapshot is immutable. Only revisable items
  // take the new amount; new heads are appended.
  const before = safeJson(current.items, []);
  const merged = before.map((item) => {
    const next = incoming.find((i) => i.headId === item.headId);
    if (!next || item.isLocked || item.category === 'SEMESTER') return item;
    return { ...item, amount: next.amount };
  });
  for (const i of incoming) if (!merged.some((m) => m.headId === i.headId)) merged.push(i);

  const updated = await prisma.batchFeeStructure.update({
    where: { id: current.id },
    data: { items: JSON.stringify(merged), syncedAt: new Date(), syncedBy: actor?.label || null },
  });
  await audit(null, 'FEE_STRUCTURE_RESYNC', 'BatchFeeStructure', current.id, {
    before: { semesterFee: current.semesterFee, items: before },
    after: { semesterFee: updated.semesterFee, items: merged },
    actor,
  });
  return { structure: shapeStructure(updated), created: false, createdHeads };
}

async function syncCycle(cycleId, actor) {
  const cycle = await prisma.admissionCycle.findUnique({
    where: { id: cycleId },
    include: { cyclePrograms: { include: { program: true } } },
  });
  if (!cycle) return [];
  await ensureDefaultHeads();
  const results = [];
  for (const cp of cycle.cyclePrograms) {
    results.push(await syncProgramStructure({ cycle, program: cp.program, breakdown: safeJson(cp.feeBreakdown, []), actor }));
  }
  return results;
}

// Revise a revisable (non-locked) item of a batch structure.
async function reviseItem(req, structureId, headId, amount) {
  const s = await prisma.batchFeeStructure.findUnique({ where: { id: structureId } });
  if (!s) return { error: 'Fee structure not found', status: 404 };
  const items = safeJson(s.items, []);
  const item = items.find((i) => i.headId === headId);
  if (!item) return { error: 'This fee head is not part of the structure', status: 404 };
  if (item.isLocked || item.category === 'SEMESTER') {
    return { error: 'This fee is locked for the batch. Only a Provost concession can change what a student pays.', status: 409 };
  }
  const before = item.amount;
  item.amount = Number(amount);
  const updated = await prisma.batchFeeStructure.update({ where: { id: s.id }, data: { items: JSON.stringify(items) } });
  await audit(req, 'FEE_STRUCTURE_REVISE', 'BatchFeeStructure', s.id, {
    before: { headId, name: item.name, amount: before },
    after: { headId, name: item.name, amount: item.amount },
  });
  return { structure: shapeStructure(updated) };
}

async function structureFor(programCode, batch) {
  if (!programCode || !batch) return null;
  const s = await prisma.batchFeeStructure.findUnique({
    where: { programCode_batch: { programCode, batch: batchLabel(batch) } },
  });
  return s ? shapeStructure(s) : null;
}

// Fee heads due from a batch structure for a semester number.
function semesterDues(structure, semester) {
  if (!structure) return [];
  return structure.items
    .filter((i) => {
      if (i.category === 'SEMESTER') return true;
      if (i.category === 'ONE_TIME') return semester === 1;
      if (i.category === 'CHARGE') return false;
      return i.isRecurring || semester === 1;
    })
    .map((i) => ({
      headId: i.headId,
      label: i.name,
      category: i.category,
      amount: i.category === 'SEMESTER' ? structure.semesterFee : i.amount,
    }))
    .filter((i) => i.amount > 0);
}

feeEvents.on(ADMISSION_ANNOUNCED, ({ cycleId, actor }) => {
  syncCycle(cycleId, actor).catch((e) => console.error('[fee-sync] failed:', e.message));
});

module.exports = {
  DEFAULT_HEADS, batchLabel, ensureDefaultHeads, listHeads, headByName,
  syncCycle, reviseItem, structureFor, semesterDues, shapeStructure,
};
