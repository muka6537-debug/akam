// ============================================================
//  TRANSCRIPT PDF (A10) — unofficial & official transcripts.
//  ------------------------------------------------------------
//  NOTE ON TEMPLATES: the two transcript template files referenced in the
//  requirements were NOT included with the delivered codebase. This layout
//  follows the standard AUST transcript structure: institution header,
//  student particulars, semester-wise course table (code / title / credit
//  hours / marks / grade / grade point / quality points), semester GPA and
//  running CGPA, official grading key, signature & verification block.
//  It is fully isolated here so it can be aligned to the templates by
//  editing this single file.
// ============================================================
const { pdfStart, header, footer, table, fmt, NAVY } = require('./resultExports');

function drawTranscript(res, record, { official = false, semester = null, filename = 'transcript' } = {}) {
  const doc = pdfStart(res, filename);
  header(doc, official ? 'OFFICIAL TRANSCRIPT' : 'UNOFFICIAL TRANSCRIPT', semester ? `Semester ${semester} Result` : 'Semester-wise Academic Record');
  const left = doc.page.margins.left;
  const avail = doc.page.width - left - doc.page.margins.right;

  const watermark = () => {
    if (official) return;
    doc.save();
    doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(70).fillColor('#e11d48').opacity(0.07)
      .text('UNOFFICIAL', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false });
    doc.restore();
    doc.opacity(1).fillColor('#000');
  };
  watermark();
  doc.on('pageAdded', watermark);

  // Student particulars (two columns)
  const p = record.profile || {};
  const pairs = [
    ['Name', p.fullName], ['Father Name', p.fatherName],
    ['Roll No', p.rollNumber], ['Registration No', p.registrationNumber],
    ['Program', p.program], ['Department', p.department],
    ['Batch', p.batch], ['Current Session', record.currentSession],
  ];
  const colW = avail / 2;
  const y0 = doc.y;
  pairs.forEach(([k, v], i) => {
    const x = left + (i % 2) * colW;
    const y = y0 + Math.floor(i / 2) * 14;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111').text(`${k}:`, x, y, { width: 88, lineBreak: false });
    doc.font('Helvetica').text(String(v || '—'), x + 90, y, { width: colW - 94, lineBreak: false, ellipsis: true });
  });
  doc.y = y0 + Math.ceil(pairs.length / 2) * 14 + 8; doc.x = left;

  const cols = [
    ['Course Code', 'courseCode', 0.13], ['Course Title', 'courseTitle', 0.35], ['Cr. Hrs', 'creditHours', 0.08, 'center'],
    ['Marks %', 'pct', 0.1, 'center'], ['Grade', 'letterGrade', 0.08, 'center'], ['Grade Point', 'gp', 0.12, 'center'],
    ['Cr x GP', 'qp', 0.14, 'center'],
  ].map(([h, k, w, a]) => ({ header: h, key: k, width: w * avail, align: a }));

  const sems = (record.semesters || []).filter((s) => s.declared
    && (!semester || String(s.semester) === String(semester))
    && (!official || s.official));
  for (const s of sems) {
    if (doc.y > doc.page.height - 180) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY)
      .text(`Semester ${s.semester}${s.term ? ` — ${s.term}` : ''}   (${s.official ? 'Official' : 'Unofficial'})`, left, doc.y, { width: avail });
    doc.moveDown(0.2).fillColor('#000');
    const rows = s.subjects.map((x) => ({ ...x, pct: fmt(x.totalPercent), gp: fmt(x.gradePoints), qp: fmt((x.creditHours || 0) * (x.gradePoints || 0)) }));
    rows.push({ courseTitle: 'Semester Totals', creditHours: s.credits, gp: `GPA ${fmt(s.gpa)}`, qp: fmt(s.subjects.reduce((a, x) => a + (x.creditHours || 0) * (x.gradePoints || 0), 0)), __bold: true, __fill: '#eef2ff' });
    table(doc, cols, rows, { fontSize: 8 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#000')
      .text(`Semester GPA: ${fmt(s.gpa)}      Cumulative CGPA: ${fmt(s.cgpa)}${s.probation && s.probation.onProbation ? `      Academic Standing: ${s.probation.label}` : ''}`, left, doc.y, { width: avail });
    doc.moveDown(0.7);
  }
  if (!sems.length) doc.font('Helvetica').fontSize(10).text('No declared results are available for this transcript yet.', left, doc.y, { align: 'center', width: avail });

  const last = sems[sems.length - 1];
  doc.moveDown(0.2).font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
    .text(`CGPA: ${fmt(last ? last.cgpa : null)}      Credit Hours Completed: ${sems.reduce((a, s) => a + s.credits, 0)}`, left, doc.y, { width: avail });
  doc.fillColor('#000').moveDown(0.6);

  if (doc.y > doc.page.height - 160) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(8).text('Grading Key (AUST Academic Rules §19.8)', left, doc.y, { width: avail });
  doc.font('Helvetica').fontSize(7.5).text([
    'A: 85–100 = 4.00', 'A-: 80-84 = 4.00', 'B: 73–79 = 3.3–3.9', 'B-: 70-72 = 3.0-3.2', 'C: 63–69 = 2.3–2.9',
    'C-: 60-62 = 2.0-2.2', 'D: 50–59 = 1.0–1.9', 'F: 0–49 = 0 (MPhil 0–59, PhD 0–64)', 'W: Withdrawn', 'I: Incomplete',
  ].join('   |   '), { width: avail });
  doc.moveDown(0.3).text('GPA = Sum(Course Credit Hours x Grade Point) / Total Semester Credit Hours.   CGPA = Sum(Credit Hours x Grade Point, all semesters) / Total Credit Hours taken.', { width: avail });

  doc.moveDown(2.4);
  const sy = doc.y;
  doc.moveTo(left, sy).lineTo(left + 150, sy).strokeColor('#333').lineWidth(0.7).stroke();
  doc.moveTo(left + avail - 150, sy).lineTo(left + avail, sy).stroke();
  doc.font('Helvetica').fontSize(8).text('Prepared / Checked by', left, sy + 3, { width: 150, align: 'center' });
  doc.text('Controller of Examinations', left + avail - 150, sy + 3, { width: 150, align: 'center' });
  doc.moveDown(1.2).fontSize(7).fillColor('#666').text(official
    ? 'This transcript is issued on declaration of the official result. Any alteration renders it invalid.'
    : 'UNOFFICIAL — for information only. The official transcript becomes available once the official result is declared.', left, doc.y, { align: 'center', width: avail });
  footer(doc);
  doc.end();
}

module.exports = { drawTranscript };
