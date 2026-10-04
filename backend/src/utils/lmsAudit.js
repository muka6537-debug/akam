// ============================================================
//  LMS AUDIT SERVICE
//  ------------------------------------------------------------
//  Writes an LmsAuditLog row for any academic-core action. Failures
//  are swallowed (audit must never break the primary operation).
//
//  Usage:
//    await audit(req, 'ATTENDANCE_MARK', 'AttendanceSession', sessionId,
//                { before, after });
// ============================================================
const prisma = require('./prisma');

function clientIp(req) {
  if (!req) return null;
  return (
    (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
    (req.socket && req.socket.remoteAddress) ||
    null
  );
}

// `actor` labels events with no LMS session behind them (admissions-side
// triggers, scheduled jobs), e.g. { role: 'DirectorAdmissions', label: email }.
async function audit(req, action, entity, entityId, { before, after, actor: system } = {}) {
  try {
    const actor = req && req.lmsUser ? req.lmsUser : null;
    const systemRole = system ? [system.role, system.label].filter(Boolean).join(':') : null;
    await prisma.lmsAuditLog.create({
      data: {
        actorId: actor ? actor.id : null,
        actorRole: actor ? actor.role : systemRole,
        action,
        entity,
        entityId: entityId != null ? String(entityId) : null,
        beforeJson: before !== undefined ? JSON.stringify(before) : null,
        afterJson: after !== undefined ? JSON.stringify(after) : null,
        ip: clientIp(req),
        userAgent: req && req.headers ? req.headers['user-agent'] || null : null,
      },
    });
  } catch (e) {
    // Never let auditing break the request.
    console.warn('[lmsAudit] skipped:', e.message);
  }
}

module.exports = { audit, clientIp };
