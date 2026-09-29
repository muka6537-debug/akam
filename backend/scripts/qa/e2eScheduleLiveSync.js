// QA — B3.a: Weekly Schedule slot → Live Classes (create / move / delete), per course.
const BASE = process.argv.slice(2).find((a) => /^https?:/.test(a)) || 'http://localhost:5000';
const API = `${BASE}/api/lms/academic`;
let pass = 0; let fail = 0;
const ok = (c, m, x) => { if (c) { pass += 1; console.log('  ✔', m); } else { fail += 1; console.log('  ✘', m, x !== undefined ? JSON.stringify(x).slice(0, 300) : ''); } };
const login = async (u) => (await (await fetch(`${BASE}/api/lms/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Lms@1234' }) })).json()).token;
const call = async (t, m, p, b) => { const r = await fetch(`${API}${p}`, { method: m, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };
const localHM = (d) => { const x = new Date(new Date(d).getTime() + 300 * 60000); return { dow: x.getUTCDay(), hm: `${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}` }; };
(async () => {
  const prisma = require('../../src/utils/prisma');
  const coordUser = await prisma.lmsUser.findUnique({ where: { username: 'coord1' } });
  const off = await prisma.courseOffering.findFirst({ where: { course: { code: 'MT-101' } }, include: { course: { include: { program: true } }, registrations: { take: 1, include: { student: true } } } });
  await prisma.lmsStudentProfile.updateMany({ where: { lmsUserId: coordUser.id }, data: { department: off.course.program.department } });
  const coord = await login('coord1');
  const stuName = off.registrations[0].student.username;
  const stu = await login(stuName);
  console.log(`Offering ${off.course.code} · student ${stuName}`);
  const snapshot = async () => JSON.stringify(await prisma.liveClass.findMany({ where: { offeringId: { not: off.id } }, orderBy: { id: 'asc' }, select: { id: true, scheduledAt: true, isDeleted: true, durationMin: true } }));
  const before = await snapshot();
  // Create a Saturday 18:10–19:00 slot (unlikely to clash).
  let r = await call(coord, 'POST', '/coordinator/schedule', { offeringId: off.id, dayOfWeek: 6, startTime: '18:10', endTime: '19:00', room: 'Online', mode: 'ONLINE', force: true });
  ok(r.status === 201 && r.data.liveClasses.created >= 4, `slot created → ${r.data && r.data.liveClasses && r.data.liveClasses.created} live classes auto-generated`, r.data);
  const slotId = r.data.slot.id;
  let lcs = await prisma.liveClass.findMany({ where: { scheduleSlotId: slotId, isDeleted: false } });
  ok(lcs.every((l) => { const t = localHM(l.scheduledAt); return t.dow === 6 && t.hm === '18:10' && l.durationMin === 50; }), 'every occurrence is Saturday 18:10 for 50 minutes (matches the slot)');
  ok(lcs.every((l) => l.offeringId === off.id && l.title.startsWith(off.course.code)), 'live classes belong only to this course and carry its code + name');
  r = await call(stu, 'GET', '/student/live-classes');
  const mine = r.data.liveClasses.filter((l) => lcs.some((x) => x.id === l.id));
  ok(mine.length === lcs.length && mine.every((l) => l.courseCode === off.course.code && l.courseTitle && l.fromSchedule), 'enrolled student sees them with course code + name', mine[0]);
  // Move the slot to Thursday 09:40–10:30.
  r = await call(coord, 'PUT', `/coordinator/schedule/${slotId}`, { dayOfWeek: 4, startTime: '09:40', endTime: '10:30', force: true });
  ok(r.status === 200 && r.data.liveClasses.removed >= 1 && r.data.liveClasses.created >= 1, 'moving the slot reschedules its live classes', r.data.liveClasses);
  lcs = await prisma.liveClass.findMany({ where: { scheduleSlotId: slotId, isDeleted: false, status: 'SCHEDULED', scheduledAt: { gt: new Date() } } });
  ok(lcs.length > 0 && lcs.every((l) => { const t = localHM(l.scheduledAt); return t.dow === 4 && t.hm === '09:40'; }), 'all upcoming occurrences now Thursday 09:40');
  // Other courses untouched.
  ok((await snapshot()) === before, 'no mixing: other courses\' live classes untouched');
  r = await call(coord, 'DELETE', `/coordinator/schedule/${slotId}`);
  ok(r.status === 200 && r.data.liveClasses.removed >= lcs.length, 'deleting the slot removes its upcoming live classes', r.data);
  const left = await prisma.liveClass.count({ where: { scheduleSlotId: slotId, isDeleted: false } });
  ok(left === 0, 'none left');
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
