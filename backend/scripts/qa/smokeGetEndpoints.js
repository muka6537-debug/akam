// QA helper: log in as each LMS role and hit every parameter-less GET route of the
// LMS academic routers. Prints "role path status" — used to diff before/after changes.
// Usage: node scripts/qa/smokeGetEndpoints.js [baseUrl]
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:5000';
const ROUTERS = {
  Teacher: ['teacher'], Student: ['student'], CourseCoordinator: ['coordinator'],
  ExamController: ['exam'], FocalPerson: ['focal'], QECCoordinator: ['qec'], Provost: ['provost'],
};
const FILES = { teacher: 'teacher.js', student: 'student.js', coordinator: ['coordinator.js', 'coordinatorPlus.js', 'scheme.js'], exam: 'exam.js', focal: 'focal.js', qec: 'directorqec.js', provost: 'provost.js' };
const USERS = { Teacher: 'teacher1', Student: 'ADCS-001', CourseCoordinator: 'coord1', ExamController: 'exam1', FocalPerson: 'focal1', QECCoordinator: 'qec1', Provost: 'provost1' };
const SKIP = /\/events$|\/stream|download|export|\/pdf|\/excel/;
function routesOf(prefix) {
  const files = [].concat(FILES[prefix]);
  const out = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/lms/academic', f), 'utf8');
    for (const m of src.matchAll(/router\.get\('([^']+)'/g)) if (!m[1].includes(':') && !SKIP.test(m[1])) out.add(m[1]);
  }
  return [...out];
}
(async () => {
  for (const [role, prefixes] of Object.entries(ROUTERS)) {
    const r = await fetch(`${BASE}/api/lms/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USERS[role], password: 'Lms@1234' }) });
    const j = await r.json();
    if (!j.token) { console.log(role, 'LOGIN_FAILED', JSON.stringify(j).slice(0, 120)); continue; }
    for (const p of prefixes) for (const route of routesOf(p)) {
      const res = await fetch(`${BASE}/api/lms/academic/${p}${route}`, { headers: { Authorization: `Bearer ${j.token}` } });
      console.log(role, `/${p}${route}`, res.status);
    }
  }
})();
