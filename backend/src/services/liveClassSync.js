// ============================================================
//  B3.a — WEEKLY SCHEDULE → LIVE CLASSES (auto, real time)
//  ------------------------------------------------------------
//  Every Weekly Schedule slot created / moved / deleted by the Course
//  Coordinator is mirrored into LiveClass rows for that slot's OWN
//  offering, at exactly the slot's day + start time (duration = slot
//  length). Each course is synced independently — no mixing.
//
//  • Generates the upcoming occurrences within a rolling horizon
//    (default 4 weeks) and tops the horizon up on every read.
//  • Only future, not-yet-started auto rows (scheduleSlotId set,
//    status SCHEDULED) are ever rescheduled or removed; manually
//    scheduled live classes (scheduleSlotId null) are never touched,
//    and classes that already ran keep their history.
//  • Emits a `liveclass` SSE event to the offering's students + teacher.
// ============================================================
const prisma = require('../utils/prisma');
const realtime = require('../utils/lmsRealtime');

const HORIZON_WEEKS = 4;
const DAY_MS = 86400000;
// Schedule times are local campus times (Pakistan, UTC+5, no DST).
const TZ_OFFSET_MIN = Number(process.env.LMS_TZ_OFFSET_MINUTES || 300);

const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** Next N occurrences (as UTC Date) of weekday `dow` at local `hhmm`, from `from`. */
function occurrences(dow, hhmm, from = new Date(), weeks = HORIZON_WEEKS) {
  const out = [];
  const localNow = new Date(from.getTime() + TZ_OFFSET_MIN * 60000);
  const startOfLocalDay = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const minutes = toMin(hhmm);
  for (let d = 0; d < weeks * 7; d += 1) {
    const dayUtc = startOfLocalDay + d * DAY_MS;
    if (new Date(dayUtc).getUTCDay() !== Number(dow)) continue;
    const at = new Date(dayUtc + minutes * 60000 - TZ_OFFSET_MIN * 60000);
    if (at.getTime() + 60000 > from.getTime()) out.push(at);
  }
  return out;
}

async function recipients(offeringId) {
  const [off, regs] = await Promise.all([
    prisma.courseOffering.findUnique({ where: { id: offeringId }, select: { teacherId: true } }),
    prisma.courseRegistration.findMany({ where: { offeringId, status: 'ENROLLED' }, select: { studentId: true } }),
  ]);
  return [...new Set([...(off && off.teacherId ? [off.teacherId] : []), ...regs.map((r) => r.studentId)])];
}

/** Sync one schedule slot's live classes. Returns { created, updated, removed }. */
async function syncSlot(slotId, { emit = true } = {}) {
  const slot = await prisma.scheduleSlot.findUnique({ where: { id: slotId }, include: { offering: { include: { course: true } } } });
  const now = new Date();
  const futureAuto = await prisma.liveClass.findMany({ where: { scheduleSlotId: slotId, isDeleted: false, status: 'SCHEDULED', scheduledAt: { gt: now } } });
  let created = 0; let updated = 0; let removed = 0;

  if (!slot || slot.isDeleted || !slot.offering || slot.offering.isDeleted) {
    if (futureAuto.length) {
      const r = await prisma.liveClass.updateMany({ where: { id: { in: futureAuto.map((x) => x.id) } }, data: { isDeleted: true } });
      removed = r.count;
    }
  } else {
    const duration = Math.max(15, toMin(slot.endTime) - toMin(slot.startTime));
    const course = slot.offering.course;
    const kind = (slot.slotType || 'THEORY') === 'LAB' ? 'Lab' : 'Lecture';
    const title = `${course.code} — ${course.title} (${kind})`;
    const wanted = occurrences(slot.dayOfWeek, slot.startTime, now);
    const wantedKeys = new Set(wanted.map((d) => d.getTime()));
    // Drop occurrences that no longer match (slot moved to another day/time).
    const stale = futureAuto.filter((lc) => !wantedKeys.has(new Date(lc.scheduledAt).getTime()));
    if (stale.length) {
      const r = await prisma.liveClass.updateMany({ where: { id: { in: stale.map((x) => x.id) } }, data: { isDeleted: true } });
      removed += r.count;
    }
    const have = new Map(futureAuto.filter((lc) => wantedKeys.has(new Date(lc.scheduledAt).getTime())).map((lc) => [new Date(lc.scheduledAt).getTime(), lc]));
    for (const at of wanted) {
      const ex = have.get(at.getTime());
      if (ex) {
        if (ex.durationMin !== duration || ex.title !== title) {
          await prisma.liveClass.update({ where: { id: ex.id }, data: { durationMin: duration, title } });
          updated += 1;
        }
      } else {
        await prisma.liveClass.create({
          data: {
            offeringId: slot.offeringId, scheduleSlotId: slot.id, title,
            description: `Auto-scheduled from the Weekly Schedule · ${slot.mode === 'ONLINE' ? 'Online' : `Room ${slot.room || 'TBA'}`}`,
            scheduledAt: at, durationMin: duration, status: 'SCHEDULED', hostId: slot.offering.teacherId || null,
          },
        });
        created += 1;
      }
    }
  }
  if (emit && (created || updated || removed) && slot) {
    realtime.emitTo(await recipients(slot.offeringId), 'liveclass', { action: 'schedule-sync', offeringId: slot.offeringId, created, updated, removed });
  }
  return { created, updated, removed };
}

/** Sync every active slot of the given offerings (or all current-term slots). */
async function syncOfferings(offeringIds) {
  const where = { isDeleted: false, ...(offeringIds ? { offeringId: { in: offeringIds } } : {}) };
  if (!offeringIds) {
    const term = await prisma.academicTerm.findFirst({ where: { isCurrent: true, isActive: true } });
    if (term) where.offering = { termId: term.id, isDeleted: false };
  }
  const slots = await prisma.scheduleSlot.findMany({ where, select: { id: true } });
  const total = { created: 0, updated: 0, removed: 0 };
  for (const s of slots) {
    const r = await syncSlot(s.id);
    total.created += r.created; total.updated += r.updated; total.removed += r.removed;
  }
  // Slots deleted without passing through syncSlot (e.g. bulk clear).
  const orphanWhere = { isDeleted: false, status: 'SCHEDULED', scheduledAt: { gt: new Date() }, scheduleSlotId: { not: null } };
  if (offeringIds) orphanWhere.offeringId = { in: offeringIds };
  const orphans = await prisma.liveClass.findMany({ where: orphanWhere, select: { id: true, scheduleSlotId: true } });
  if (orphans.length) {
    const alive = new Set((await prisma.scheduleSlot.findMany({ where: { id: { in: [...new Set(orphans.map((o) => o.scheduleSlotId))] }, isDeleted: false }, select: { id: true } })).map((s) => s.id));
    const dead = orphans.filter((o) => !alive.has(o.scheduleSlotId)).map((o) => o.id);
    if (dead.length) total.removed += (await prisma.liveClass.updateMany({ where: { id: { in: dead } }, data: { isDeleted: true } })).count;
  }
  return total;
}

// Throttled top-up used by live-class list endpoints (keeps the rolling horizon full).
let lastTopUp = 0;
async function topUp() {
  if (Date.now() - lastTopUp < 10 * 60000) return;
  lastTopUp = Date.now();
  try { await syncOfferings(); } catch (_) { /* never block reads */ }
}

module.exports = { syncSlot, syncOfferings, topUp, occurrences, HORIZON_WEEKS };
