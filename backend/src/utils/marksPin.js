// ============================================================
//  A4 — MARKS MODULE PIN SECURITY
//  ------------------------------------------------------------
//  A separate 5-digit numeric PIN (independent of the login password)
//  gates the teacher Marks / Gradebook / Results-Submission modules.
//
//  Hardening on top of the PIN:
//   • PIN is bcrypt-hashed (cost 10); never returned or logged.
//   • Trivial PINs are rejected (all-same digits, simple sequences).
//   • 5 consecutive wrong entries → 15-minute lockout (server-side,
//     survives refresh / new tab / new login).
//   • A correct PIN mints a short-lived "marks session" JWT (10 min,
//     sliding) bound to the teacher id + pinVersion + purpose. The
//     frontend keeps it in memory only (never localStorage), so every
//     fresh open / refresh / back-navigation re-prompts for the PIN.
//   • Every marks/gradebook/results API call requires the token
//     (X-Marks-Token); re-setting the PIN bumps pinVersion and
//     invalidates every outstanding token.
//   • Final/subject submissions re-verify the PIN itself, not just
//     the session token.
//   • All PIN events are written to the LMS audit log.
// ============================================================
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('./prisma');

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const SESSION_MINUTES = 10;
const PURPOSE = 'marks-pin';

function err(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status; e.expose = true;
  Object.assign(e, extra);
  return e;
}

function validatePinFormat(pin) {
  const p = String(pin == null ? '' : pin);
  if (!/^\d{5}$/.test(p)) throw err(400, 'PIN must be exactly 5 digits (0-9).');
  if (/^(\d)\1{4}$/.test(p)) throw err(400, 'PIN is too weak: all digits are the same.');
  if ('0123456789'.includes(p) || '9876543210'.includes(p)) throw err(400, 'PIN is too weak: avoid simple sequences like 12345.');
  return p;
}

async function getRecord(userId) {
  return prisma.teacherMarksPin.findUnique({ where: { lmsUserId: userId } });
}

function issueToken(userId, pinVersion) {
  return jwt.sign({ sub: userId, v: pinVersion, purpose: PURPOSE, system: 'lms' }, process.env.JWT_SECRET, { expiresIn: `${SESSION_MINUTES}m` });
}

async function status(userId) {
  const rec = await getRecord(userId);
  const locked = !!(rec && rec.lockedUntil && rec.lockedUntil > new Date());
  return {
    isSet: !!rec,
    locked,
    lockedUntil: locked ? rec.lockedUntil : null,
    attemptsRemaining: rec ? Math.max(0, MAX_ATTEMPTS - rec.failedAttempts) : MAX_ATTEMPTS,
    sessionMinutes: SESSION_MINUTES,
  };
}

/** First-time PIN setup. Requires the account password as a second factor. */
async function setupPin(userId, { pin, confirmPin, password }) {
  const existing = await getRecord(userId);
  if (existing) throw err(409, 'A Marks PIN is already set. Use "Change PIN" instead.');
  const p = validatePinFormat(pin);
  if (String(confirmPin) !== p) throw err(400, 'PIN and confirmation do not match.');
  await assertPassword(userId, password);
  const rec = await prisma.teacherMarksPin.create({ data: { lmsUserId: userId, pinHash: await bcrypt.hash(p, 10) } });
  return { token: issueToken(userId, rec.pinVersion), expiresInSec: SESSION_MINUTES * 60 };
}

/** Change PIN (needs current PIN + account password). Invalidates all sessions. */
async function changePin(userId, { currentPin, pin, confirmPin, password }) {
  const rec = await getRecord(userId);
  if (!rec) throw err(404, 'No Marks PIN is set yet.');
  await verifyPin(userId, currentPin); // counts toward lockout
  const p = validatePinFormat(pin);
  if (String(confirmPin) !== p) throw err(400, 'PIN and confirmation do not match.');
  await assertPassword(userId, password);
  const upd = await prisma.teacherMarksPin.update({
    where: { lmsUserId: userId },
    data: { pinHash: await bcrypt.hash(p, 10), pinVersion: { increment: 1 }, failedAttempts: 0, lockedUntil: null },
  });
  return { token: issueToken(userId, upd.pinVersion), expiresInSec: SESSION_MINUTES * 60 };
}

async function assertPassword(userId, password) {
  const u = await prisma.lmsUser.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!u || !password || !(await bcrypt.compare(String(password), u.passwordHash))) {
    throw err(401, 'Account password is incorrect.');
  }
}

/**
 * Verify a PIN with lockout. Returns the PIN record on success, throws
 * 401 (wrong, with attemptsRemaining) / 423 (locked) otherwise.
 */
async function verifyPin(userId, pin) {
  const rec = await getRecord(userId);
  if (!rec) throw err(428, 'Set up your Marks PIN first.', { code: 'PIN_NOT_SET' });
  if (rec.lockedUntil && rec.lockedUntil > new Date()) {
    throw err(423, `Too many wrong PIN attempts. The Marks module is locked until ${rec.lockedUntil.toLocaleTimeString()}.`, { lockedUntil: rec.lockedUntil });
  }
  const ok = /^\d{5}$/.test(String(pin || '')) && (await bcrypt.compare(String(pin), rec.pinHash));
  if (!ok) {
    const attempts = rec.failedAttempts + 1;
    const lock = attempts >= MAX_ATTEMPTS;
    await prisma.teacherMarksPin.update({
      where: { lmsUserId: userId },
      data: { failedAttempts: lock ? 0 : attempts, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null },
    });
    if (lock) throw err(423, `Too many wrong PIN attempts. The Marks module is locked for ${LOCK_MINUTES} minutes.`);
    throw err(401, `Incorrect PIN. ${MAX_ATTEMPTS - attempts} attempt(s) remaining before lockout.`, { attemptsRemaining: MAX_ATTEMPTS - attempts });
  }
  await prisma.teacherMarksPin.update({ where: { lmsUserId: userId }, data: { failedAttempts: 0, lockedUntil: null, lastVerifiedAt: new Date() } });
  return rec;
}

async function unlock(userId, pin) {
  const rec = await verifyPin(userId, pin);
  return { token: issueToken(userId, rec.pinVersion), expiresInSec: SESSION_MINUTES * 60 };
}

/**
 * Express middleware: requires a valid, unexpired marks-session token bound to
 * this teacher and the current pinVersion. Sends a refreshed token back in the
 * X-Marks-Token response header (sliding session).
 */
function requireMarksSession(req, res, next) {
  (async () => {
    const token = req.headers['x-marks-token'];
    if (!token) throw err(423, 'The Marks module is locked. Enter your 5-digit PIN to continue.', { code: 'MARKS_PIN_REQUIRED' });
    let decoded;
    try { decoded = jwt.verify(String(token), process.env.JWT_SECRET); } catch (_) {
      throw err(423, 'Your Marks session has expired. Re-enter your PIN.', { code: 'MARKS_PIN_REQUIRED' });
    }
    if (decoded.purpose !== PURPOSE || decoded.sub !== req.lmsUser.id) {
      throw err(423, 'Invalid Marks session. Re-enter your PIN.', { code: 'MARKS_PIN_REQUIRED' });
    }
    const rec = await getRecord(req.lmsUser.id);
    if (!rec || rec.pinVersion !== decoded.v || (rec.lockedUntil && rec.lockedUntil > new Date())) {
      throw err(423, 'Your Marks session is no longer valid. Re-enter your PIN.', { code: 'MARKS_PIN_REQUIRED' });
    }
    res.setHeader('X-Marks-Token', issueToken(req.lmsUser.id, rec.pinVersion));
    res.setHeader('Access-Control-Expose-Headers', 'X-Marks-Token');
    next();
  })().catch((e) => res.status(e.status || 423).json({ error: e.message, code: e.code || 'MARKS_PIN_REQUIRED' }));
}

module.exports = {
  MAX_ATTEMPTS, LOCK_MINUTES, SESSION_MINUTES,
  status, setupPin, changePin, unlock, verifyPin, requireMarksSession, validatePinFormat,
};
