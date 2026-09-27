// ============================================================
// QA — END-TO-END RESULT PIPELINE (Part A), exercised over HTTP.
//   Coordinator weightage → teacher hard limits → PIN (setup/lockout/session)
//   → assessment creation → student submission → grading (real-time sync)
//   → weightage conversion → Mid/Final totals → subject publish (PIN, lock)
//   → final submission (immutable) → Exam Controller compilation / collection
//   → declare unofficial → student GPA/CGPA/transcript → declare official
//   → archive → gazette → Excel/PDF exports at every stage.
// Usage: node scripts/qa/e2eResultPipeline.js [baseUrl]
// Idempotency: the script creates its own term-2 offering data on CS-202
// (teacher1) and is safe to re-run on a fresh seed. On a re-run the
// already-submitted offering is detected and pipeline steps are skipped.
// ============================================================
const BASE = process.argv.slice(2).find((a) => /^https?:/.test(a)) || 'http://localhost:5000';
const API = `${BASE}/api/lms/academic`;
let pass = 0; let fail = 0;
const ok = (cond, msg, extra) => { if (cond) { pass += 1; console.log(`  ✔ ${msg}`); } else { fail += 1; console.log(`  ✘ ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };

async function login(username) {
  const r = await fetch(`${BASE}/api/lms/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'Lms@1234' }) });
  const j = await r.json();
  if (!j.token) throw new Error(`login ${username}: ${JSON.stringify(j)}`);
  return j.token;
}
function client(token) {
  let marks = null;
  const call = async (method, path, body, raw = false) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (marks) headers['X-Marks-Token'] = marks;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const next = r.headers.get('x-marks-token'); if (next) marks = next;
    if (raw) return { status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
    let data = null; try { data = await r.json(); } catch (_) { data = null; }
    return { status: r.status, data };
  };
  return { get: (p, raw) => call('GET', p, undefined, raw), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p), setMarks: (t) => { marks = t; } };
}

(async () => {
  const prisma = require('../../src/utils/prisma');
  const teacherUser = await prisma.lmsUser.findUnique({ where: { username: 'teacher1' } });
  const offering = await prisma.courseOffering.findFirst({ where: { teacherId: teacherUser.id, course: { code: 'CS-202' } }, include: { course: { include: { program: true, semester: true } } } });
  const allMine = await prisma.courseOffering.findMany({ where: { teacherId: teacherUser.id, isDeleted: false }, include: { course: true } });
  const regs = await prisma.courseRegistration.findMany({ where: { offeringId: offering.id }, include: { student: true } });
  const student = regs[0].student;
  console.log(`Offering #${offering.id} ${offering.course.code} (${offering.course.program.shortForm} sem ${offering.course.semester.number}), ${regs.length} students; test student ${student.username}`);

  const coord = client(await login('coord1'));
  const teacher = client(await login('teacher1'));
  const stu = client(await login(student.username));
  const exam = client(await login('exam1'));

  // ---- Fixture (test data only) -----------------------------------------
  // The coordinator must belong to the offering's department (strict isolation);
  // the seeded coord1 has none, so assign it like a Super Admin would.
  const coordUser = await prisma.lmsUser.findUnique({ where: { username: 'coord1' } });
  await prisma.lmsStudentProfile.updateMany({ where: { lmsUserId: coordUser.id }, data: { department: offering.course.program.department } });
  // --fresh: reset this offering's demo results so the pipeline starts clean
  // (drops the immutability triggers only for the duration of the reset).
  if (process.argv.includes('--fresh')) {
    const { installResultLockTriggers } = require('../../src/utils/resultWorkflow');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS trg_course_result_immutable_delete');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS trg_course_result_stage_forward');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS trg_course_result_immutable_update');
    // Reset the whole term: every result back to DRAFT, nothing submitted.
    await prisma.courseResult.deleteMany({ where: { offeringId: { in: (await prisma.courseOffering.findMany({ where: { teacherId: teacherUser.id } })).map((o) => o.id) } } });
    await prisma.courseResult.updateMany({ data: { workflowStage: 'DRAFT', status: 'DRAFT', lockedAt: null, submittedAt: null, unofficialAt: null, officialAt: null } });
    await installResultLockTriggers(prisma);
    await prisma.courseOffering.updateMany({ data: { resultLockedAt: null, resultSubmittedAt: null } });
    await prisma.courseOffering.updateMany({ where: { teacherId: teacherUser.id }, data: { midTotalMarks: null, finalTotalMarks: null } });
    await prisma.teacherMarksPin.deleteMany({});
    offering.resultSubmittedAt = null;
    console.log('  (fresh fixture: teacher1 results reset)');
  }
  const alreadySubmitted = !!offering.resultSubmittedAt;

  console.log('\nA1 Coordinator weightage');
  const cw = { midWeight: 25, finalWeight: 40, quizWeight: 15, assignmentWeight: 10, labTaskWeight: 0, semesterProjectWeight: 10, quizCount: 3, assignmentCount: 1, labTaskCount: 0 };
  if (!alreadySubmitted) {
    const r = await coord.put(`/coordinator/weightage/${offering.courseId}`, cw);
    ok(r.status === 200 && r.data.balanced, 'coordinator saves 1 assignment / 3 quizzes / project, balanced 100%', r.data);
  }

  console.log('\nA4 Marks PIN');
  let r = await teacher.get(`/teacher/marks/offerings/${offering.id}/gradebook`);
  ok(r.status === 423, 'gradebook refused without PIN session (423)', r.status);
  r = await teacher.get(`/teacher/offerings/${offering.id}/gradebook`);
  ok(r.status === 423, 'legacy gradebook endpoint also PIN-gated', r.status);
  const st = await teacher.get('/teacher/marks/pin/status');
  if (!st.data.isSet) {
    r = await teacher.post('/teacher/marks/pin/setup', { pin: '12345', confirmPin: '12345', password: 'Lms@1234' });
    ok(r.status === 400, 'weak sequential PIN rejected', r.data);
    r = await teacher.post('/teacher/marks/pin/setup', { pin: '48213', confirmPin: '48213', password: 'wrong' });
    ok(r.status === 401, 'setup requires correct account password', r.data);
    r = await teacher.post('/teacher/marks/pin/setup', { pin: '48213', confirmPin: '48213', password: 'Lms@1234' });
    ok(r.status === 201 && r.data.token, 'PIN set on first access', r.data);
  }
  r = await teacher.post('/teacher/marks/pin/unlock', { pin: '00000' });
  ok(r.status === 401 && r.data.attemptsRemaining === 4, 'wrong PIN → 401 with attempts remaining', r.data);
  r = await teacher.post('/teacher/marks/pin/unlock', { pin: '48213' });
  ok(r.status === 200 && r.data.token, 'correct PIN → marks session', r.data);
  teacher.setMarks(r.data.token);
  // The attempt counter resets after success.
  const pinRec = await prisma.teacherMarksPin.findUnique({ where: { lmsUserId: teacherUser.id } });
  ok(pinRec.failedAttempts === 0, 'failed attempts reset after correct PIN');
  const forged = client(await login('teacher1')); forged.setMarks('forged.token.value');
  r = await forged.get(`/teacher/marks/offerings/${offering.id}/gradebook`);
  ok(r.status === 423, 'forged marks token rejected', r.status);

  if (!alreadySubmitted) {
    console.log('\nA1 Teacher hard limits');
    // Clean any previous assessments on this offering so limits are deterministic.
    await prisma.assignment2.updateMany({ where: { offeringId: offering.id }, data: { isDeleted: true } });
    await prisma.quiz.updateMany({ where: { offeringId: offering.id }, data: { isDeleted: true } });
    r = await teacher.post(`/teacher/offerings/${offering.id}/assignments`, { title: 'Assignment 1', totalMarks: 50, dueDate: '2026-12-01' });
    ok(r.status === 201, 'assignment 1 created (out of 50)', r.data);
    const asg = r.data.assignment;
    r = await teacher.post(`/teacher/offerings/${offering.id}/assignments`, { title: 'Assignment 2', totalMarks: 50, dueDate: '2026-12-01' });
    ok(r.status === 403, 'second assignment blocked by coordinator limit', r.data);
    const quizzes = [];
    for (let i = 1; i <= 3; i += 1) {
      r = await teacher.post(`/teacher/offerings/${offering.id}/quizzes`, { title: `Quiz ${i}` });
      quizzes.push(r.data.quiz);
      ok(r.status === 201, `quiz ${i} created`);
    }
    r = await teacher.post(`/teacher/offerings/${offering.id}/quizzes`, { title: 'Quiz 4' });
    ok(r.status === 403, 'fourth quiz blocked (limit 3)', r.data);
    r = await teacher.post(`/teacher/offerings/${offering.id}/lab-tasks`, { title: 'Lab 1', dueDate: '2026-12-01' });
    ok(r.status >= 400, 'lab task impossible for a non-lab subject', r.status);
    r = await teacher.post(`/teacher/offerings/${offering.id}/assignments`, { title: 'Semester Project', kind: 'PROJECT', totalMarks: 100, dueDate: '2026-12-15' });
    ok(r.status === 201, 'project created (coordinator enabled Project)', r.data);
    const project = r.data.assignment;
    for (const q of quizzes) {
      await teacher.post(`/teacher/quizzes/${q.id}/questions`, { text: 'Q?', type: 'MCQ', options: ['a', 'b'], correctAnswer: '0', marks: 10 });
      await teacher.put(`/teacher/quizzes/${q.id}/publish`, { isPublished: true });
    }

    console.log('\nA2 Student submission → teacher grading → real-time');
    r = await stu.get(`/student/assignments/${asg.id}`);
    const form = new FormData(); form.append('content', 'My answer');
    const sres = await fetch(`${API}/student/assignments/${asg.id}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${await login(student.username)}` }, body: form });
    ok(sres.status < 300, 'student submits assignment', sres.status);
    const sub = await prisma.assignmentSubmission.findFirst({ where: { assignmentId: asg.id, studentId: student.id } });
    r = await teacher.put(`/teacher/submissions/${sub.id}/grade`, { marks: 25 });
    ok(r.status === 200, 'teacher grades 25/50', r.data);
    // Quiz via student attempt (auto graded)
    await stu.post(`/student/quizzes/${quizzes[0].id}/start`);
    const qq = await prisma.quizQuestion.findFirst({ where: { quizId: quizzes[0].id } });
    r = await stu.post(`/student/quizzes/${quizzes[0].id}/submit`, { answers: { [qq.id]: '0' } });
    ok(r.status === 200 && r.data.attempt.score === 10, 'student attempts quiz 1 (auto-graded 10/10)', r.data);

    console.log('\nA3/A5 Gradebook conversion');
    r = await teacher.get(`/teacher/marks/offerings/${offering.id}/gradebook`);
    ok(r.status === 200, 'gradebook opens with PIN session');
    const cats = r.data.categories.map((c) => c.key);
    ok(JSON.stringify(cats) === JSON.stringify(['assignment', 'quiz', 'project', 'mid', 'final']), 'exactly the configured categories (no Lab)', cats);
    const row = r.data.rows.find((x) => x.studentId === student.id);
    const asgCell = row.cells[`assignment-${asg.id}`];
    ok(asgCell.obtained === 25 && asgCell.total === 50 && asgCell.converted === 5 && asgCell.weight === 10, 'Assignment 25/50 @10% → 5 (50%)', asgCell);
    const qCell = row.cells[`quiz-${quizzes[0].id}`];
    ok(qCell.converted === 5 && qCell.weight === 5, 'Quiz 10/10 @5% → 5', qCell);
    ok(r.data.categories.find((c) => c.key === 'quiz').items.length === 3, 'quiz columns = coordinator count (3)');

    console.log('\nB2.b Mid/Final totals');
    r = await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'mid', studentId: student.id, marks: 20 });
    ok(r.status === 400, 'mid obtained blocked until Mid Total Marks set', r.data);
    r = await teacher.put(`/teacher/marks/offerings/${offering.id}/exam-totals`, { midTotalMarks: 30, finalTotalMarks: 50 });
    ok(r.status === 200, 'mid total 30 / final total 50 saved', r.data);
    r = await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'mid', studentId: student.id, marks: 35 });
    ok(r.status === 400, 'mid obtained above total rejected');
    r = await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'mid', studentId: student.id, marks: 24 });
    ok(r.status === 200 && r.data.row.cells.mid.converted === 20, 'Mid 24/30 @25% → 20', r.data.row && r.data.row.cells.mid);
    r = await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'final', studentId: student.id, marks: 40 });
    ok(r.status === 200 && r.data.row.cells.final.converted === 32, 'Final 40/50 @40% → 32');
    r = await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'project', itemId: project.id, studentId: student.id, marks: 70 });
    ok(r.status === 200 && r.data.row.cells[`project-${project.id}`].converted === 7, 'Project 70/100 @10% → 7');
    for (const q of quizzes.slice(1)) await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'quiz', itemId: q.id, studentId: student.id, marks: 8 });
    // Fill other students so the subject is complete.
    for (const reg of regs.filter((x) => x.studentId !== student.id)) {
      await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'assignment', itemId: asg.id, studentId: reg.studentId, marks: 30 + (reg.id % 15) });
      for (const q of quizzes) await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'quiz', itemId: q.id, studentId: reg.studentId, marks: 6 + (reg.id % 4) });
      await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'project', itemId: project.id, studentId: reg.studentId, marks: 60 + (reg.id % 30) });
      await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'mid', studentId: reg.studentId, marks: 15 + (reg.id % 12) });
      await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'final', studentId: reg.studentId, marks: 25 + (reg.id % 20) });
    }
    r = await teacher.get(`/teacher/marks/offerings/${offering.id}/gradebook`);
    const me = r.data.rows.find((x) => x.studentId === student.id);
    // 5 + (5 + 4 + 4) + 7 + 20 + 32 = 77 → B, 3.7
    ok(me.weightedTotal === 77 && me.letterGrade === 'B' && me.gradePoints === 3.7, 'total 77/100 → B / 3.7 (official AUST scale)', { t: me.weightedTotal, g: me.letterGrade, gp: me.gradePoints });

    console.log('\nA6 Student live view (pre-declaration)');
    r = await stu.get('/student/result-record');
    const sem = r.data.semesters.find((s) => s.subjects.some((x) => x.offeringId === offering.id));
    const subj = sem.subjects.find((x) => x.offeringId === offering.id);
    ok(!sem.declared && sem.gpa === null && subj.letterGrade === null, 'no grade / GPA shown before declaration', { declared: sem.declared, gpa: sem.gpa, grade: subj.letterGrade });
    ok(subj.breakdown && subj.breakdown.weightedTotal === 77, 'raw weightage marks visible in real time', subj.breakdown && subj.breakdown.weightedTotal);
    ok(subj.midTotalMarks === 30 && subj.midMarks === 24, 'student sees Mid obtained + total (24/30)');
    r = await stu.get(`/student/transcript/pdf/unofficial?semester=${offering.course.semester.number}`);
    ok(r.status === 403, 'transcript for undeclared semester refused', r.status);

    console.log('\nA7 Subject publish (PIN) → locked');
    r = await teacher.post(`/teacher/marks/offerings/${offering.id}/publish`, { pin: '11111' });
    ok(r.status === 401, 'publish refused with wrong PIN');
    r = await teacher.post(`/teacher/marks/offerings/${offering.id}/publish`, { pin: '48213' });
    ok(r.status === 200, 'subject published with PIN', r.data);
    r = await teacher.put(`/teacher/marks/offerings/${offering.id}/cell`, { kind: 'mid', studentId: student.id, marks: 10 });
    ok(r.status === 409, 'teacher edit blocked after subject publish', r.data);
    r = await teacher.put(`/teacher/submissions/${sub.id}/grade`, { marks: 50 });
    ok(r.status === 409, 'assignment regrade blocked after publish');

    console.log('\nA8 Final submission');
    r = await teacher.get('/teacher/marks/submission');
    ok(r.status === 200 && r.data.subjects.length === allMine.length, `status lists all ${allMine.length} subjects`, r.data.summary);
    // Publish the teacher's other open subjects so final submission is possible.
    for (const s2 of r.data.subjects.filter((x) => x.status === 'OPEN')) {
      await teacher.put(`/teacher/marks/offerings/${s2.id}/exam-totals`, { midTotalMarks: 100, finalTotalMarks: 100 });
      const pr = await teacher.post(`/teacher/marks/offerings/${s2.id}/publish`, { pin: '48213' });
      ok(pr.status === 200, `published ${s2.courseCode}`, pr.data);
    }
    r = await teacher.post('/teacher/marks/final-submit', { pin: '48213' });
    ok(r.status === 200, 'final submission to Exam Controller', r.data);
  }

  // Other teachers of the same semester submit their subjects too (a semester
  // can only be declared once every subject in it has been submitted).
  console.log('\nA8 Other semester teachers submit');
  const semOfferings = await prisma.courseOffering.findMany({ where: { isDeleted: false, courseId: { not: offering.courseId }, course: { programId: offering.course.programId, semesterId: offering.course.semesterId }, registrations: { some: {} } }, include: { teacher: true, course: true } });
  const otherTeachers = [...new Set(semOfferings.filter((o) => o.teacher && !o.resultSubmittedAt).map((o) => o.teacher.username))];
  for (const uname of otherTeachers) {
    const t = client(await login(uname));
    const tu = await prisma.lmsUser.findUnique({ where: { username: uname } });
    if (!(await prisma.teacherMarksPin.findUnique({ where: { lmsUserId: tu.id } }))) await t.post('/teacher/marks/pin/setup', { pin: '48213', confirmPin: '48213', password: 'Lms@1234' });
    const u = await t.post('/teacher/marks/pin/unlock', { pin: '48213' });
    t.setMarks(u.data.token);
    const subs = (await t.get('/teacher/marks/submission')).data.subjects;
    for (const s2 of subs.filter((x) => x.status === 'OPEN')) {
      await t.put(`/teacher/marks/offerings/${s2.id}/exam-totals`, { midTotalMarks: 100, finalTotalMarks: 100 });
      const gb = (await t.get(`/teacher/marks/offerings/${s2.id}/gradebook`)).data;
      for (const row of gb.rows) {
        await t.put(`/teacher/marks/offerings/${s2.id}/cell`, { kind: 'mid', studentId: row.studentId, marks: 55 + (row.studentId.charCodeAt(3) % 30) });
        await t.put(`/teacher/marks/offerings/${s2.id}/cell`, { kind: 'final', studentId: row.studentId, marks: 50 + (row.studentId.charCodeAt(5) % 40) });
      }
      await t.post(`/teacher/marks/offerings/${s2.id}/publish`, { pin: '48213' });
    }
    const fs2 = await t.post('/teacher/marks/final-submit', { pin: '48213' });
    ok(fs2.status === 200, `${uname} final-submitted ${subs.length} subject(s)`, fs2.data);
  }

  console.log('\nImmutability for every role');
  const lockedRow = await prisma.courseResult.findFirst({ where: { offeringId: offering.id, studentId: student.id } });
  ok(['SUBMITTED', 'UNOFFICIAL', 'OFFICIAL'].includes(lockedRow.workflowStage), `result stage is ${lockedRow.workflowStage}`);
  try { await prisma.courseResult.update({ where: { id: lockedRow.id }, data: { finalMarks: 1 } }); ok(false, 'DB blocks direct edit'); } catch (_) { ok(true, 'DB trigger blocks direct edit (any role / Super Admin)'); }
  r = await teacher.put(`/teacher/offerings/${offering.id}/marks/${student.id}`, { midMarks: 1 });
  ok(r.status === 409, 'legacy teacher marks endpoint blocked', r.status);
  r = await exam.put(`/exam/offerings/${offering.id}/marks`, { marks: [] });
  ok(r.status === 403, 'Exam Controller cannot edit marks');

  console.log('\nA9 Exam Controller stages');
  const scope = { department: offering.course.program.department, program: offering.course.program.shortForm, semester: String(offering.course.semester.number) };
  const qs = `?department=${encodeURIComponent(scope.department)}&program=${scope.program}&semester=${scope.semester}`;
  r = await exam.get('/exam/workflow/compilation/tree');
  ok(r.status === 200 && r.data.tree.length > 0 && r.data.tree[0].programs[0].semesters.length > 0, 'compilation tree Department → Program → Semester → Subject');
  r = await exam.get(`/exam/workflow/compilation/subject/${offering.id}`);
  ok(r.status === 200 && r.data.students.length === regs.length && r.data.students[0].gradePoints != null, 'subject sheet with marks + GP + GPA for all students');
  for (const stage of ['compilation', 'collection', 'finalizing', 'archive']) {
    const x = await exam.get(`/exam/workflow/${stage}/export/excel${qs}`, true);
    const p = await exam.get(`/exam/workflow/${stage}/export/pdf${qs}`, true);
    ok(x.status === 200 && /spreadsheet/.test(x.type) && x.size > 1000, `${stage} Excel export`, x);
    ok(p.status === 200 && /pdf/.test(p.type) && p.size > 1000, `${stage} PDF export`, p);
  }
  const stageNow = (await prisma.courseResult.findFirst({ where: { offeringId: offering.id } })).workflowStage;
  if (stageNow === 'SUBMITTED') {
    r = await exam.post('/exam/workflow/collection/declare-unofficial', { ...scope });
    ok(r.status === 400, 'declaration requires explicit confirmation');
    r = await exam.post('/exam/workflow/collection/declare-unofficial', { ...scope, confirm: true });
    ok(r.status === 200 && r.data.declared > 0, 'Declare Unofficial Result', r.data);
  }
  r = await exam.get('/exam/workflow/collection/tree');
  const stillInCollection = JSON.stringify(r.data.tree).includes(`"offeringId":${offering.id}`);
  ok(!stillInCollection, 'semester moved out of Results Collection');

  console.log('\nA10 Student visibility after unofficial');
  r = await stu.get('/student/result-record');
  const sem2 = r.data.semesters.find((s) => s.subjects.some((x) => x.offeringId === offering.id));
  ok(sem2.declared && sem2.gpa != null && sem2.cgpa != null, `semester GPA ${sem2.gpa} / CGPA ${sem2.cgpa} visible`);
  const x2 = await stu.get(`/student/transcript/pdf/unofficial?semester=${scope.semester}`, true);
  ok(x2.status === 200 && /pdf/.test(x2.type), 'unofficial transcript downloadable');
  const o2 = await stu.get(`/student/transcript/pdf/official?semester=${scope.semester}`, true);
  if (!sem2.official) ok(o2.status === 403, 'official transcript not yet available');

  console.log('\nA9.3 Declare Official → Archive');
  if (!sem2.official) {
    r = await exam.post('/exam/workflow/finalizing/declare-official', { ...scope, confirm: true });
    ok(r.status === 200, 'Declare Official Result', r.data);
  }
  r = await exam.get(`/exam/workflow/archive/subject/${offering.id}`);
  ok(r.status === 200 && r.data.students.every((s) => s.workflowStage === 'OFFICIAL'), 'subject is in Results Archive (OFFICIAL)');
  const o3 = await stu.get(`/student/transcript/pdf/official?semester=${scope.semester}`, true);
  ok(o3.status === 200 && /pdf/.test(o3.type), 'official transcript downloadable');
  try { await prisma.courseResult.update({ where: { id: lockedRow.id }, data: { workflowStage: 'SUBMITTED' } }); ok(false, 'stage rollback blocked'); } catch (_) { ok(true, 'archived result cannot move back a stage'); }

  console.log('\nA11 Gazette by batch');
  r = await exam.get('/exam/workflow/gazette/batches');
  const batch = (student.username && (await prisma.lmsStudentProfile.findUnique({ where: { lmsUserId: student.id } })).session);
  ok(r.status === 200 && r.data.batches.some((b) => b.batch === batch), `batch "${batch}" listed with current session "${r.data.batches[0] && r.data.batches[0].currentSession}"`);
  r = await exam.get(`/exam/workflow/gazette?batch=${encodeURIComponent(batch)}`);
  const gs = r.data.students.find((s) => s.studentId === student.id);
  ok(gs && gs.semesters.length >= 1 && gs.cgpa != null, 'gazette: per-semester blocks + CGPA for student', gs && { sems: gs.semesters.map((s) => s.semester), cgpa: gs.cgpa });
  for (const f of ['excel', 'pdf']) {
    const g = await exam.get(`/exam/workflow/gazette/export/${f}?batch=${encodeURIComponent(batch)}`, true);
    ok(g.status === 200 && g.size > 1000, `gazette ${f} export`, g);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
