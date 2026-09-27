// ============================================================
//  RESULT EXPORTS — Excel + PDF primitives shared by every Exam
//  Controller stage, the Gazette and student transcripts.
//  Transcript layout lives in transcriptPdf.js.
// ============================================================
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const LOGO = path.join(__dirname, '..', '..', 'assets', 'aust-logo.jpg');
const UNI = 'Abbottabad University of Science & Technology';
const NAVY = '#1e3a8a';
const fmt = (v, d = 2) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
const safeName = (s) => String(s || 'export').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 90);

// ---------------- Excel ----------------
function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
}

/** sections: [{ title, columns:[{header,key,width}], rows:[{}] }] */
async function excel(res, filename, title, subtitle, sections) {
  const wb = new ExcelJS.Workbook();
  wb.creator = UNI;
  const ws = wb.addWorksheet('Results');
  const width = Math.max(4, ...sections.map((s) => s.columns.length));
  const banner = (text, size, bold = true) => {
    const r = ws.addRow([text]);
    ws.mergeCells(r.number, 1, r.number, width);
    r.font = { bold, size, color: { argb: 'FF1E3A8A' } };
    r.alignment = { horizontal: 'center' };
  };
  banner(UNI, 14);
  banner(title, 12);
  if (subtitle) banner(subtitle, 10, false);
  banner(`Generated ${new Date().toLocaleString()}`, 9, false);
  if (!sections.length) { ws.addRow([]); banner('No records in this scope.', 10, false); }
  for (const sec of sections) {
    ws.addRow([]);
    if (sec.title) {
      const t = ws.addRow([sec.title]);
      ws.mergeCells(t.number, 1, t.number, width);
      t.font = { bold: true, size: 11 };
      t.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    }
    styleHeader(ws.addRow(sec.columns.map((c) => c.header)));
    for (const row of sec.rows) {
      const r = ws.addRow(sec.columns.map((c) => (row[c.key] == null ? '' : row[c.key])));
      r.eachCell((c) => { c.border = { top: { style: 'hair' }, bottom: { style: 'hair' }, left: { style: 'hair' }, right: { style: 'hair' } }; });
      if (row.__bold) r.font = { bold: true };
    }
    sec.columns.forEach((c, i) => { const col = ws.getColumn(i + 1); col.width = Math.max(col.width || 10, c.width || 14); });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(filename)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// ---------------- PDF primitives ----------------
function pdfStart(res, filename, { landscape = false } = {}) {
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(filename)}.pdf"`);
  doc.pipe(res);
  return doc;
}

function header(doc, title, subtitle) {
  const top = doc.page.margins.top;
  const left = doc.page.margins.left;
  const w = doc.page.width - left - doc.page.margins.right;
  if (fs.existsSync(LOGO)) { try { doc.image(LOGO, left, top - 6, { width: 44 }); } catch (_) { /* ignore */ } }
  doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text(UNI, left, top, { align: 'center', width: w });
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Office of the Controller of Examinations', { align: 'center', width: w });
  doc.moveDown(0.3).font('Helvetica-Bold').fontSize(12).fillColor('#111').text(title, { align: 'center', width: w });
  if (subtitle) doc.font('Helvetica').fontSize(9).fillColor('#555').text(subtitle, { align: 'center', width: w });
  const y = Math.max(doc.y + 4, top + 48);
  doc.moveTo(left, y).lineTo(left + w, y).lineWidth(1).strokeColor(NAVY).stroke();
  doc.y = y + 8; doc.x = left; doc.fillColor('#000');
}

function footer(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const left = doc.page.margins.left;
    const w = doc.page.width - left - doc.page.margins.right;
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow writing in the margin without auto page-add
    doc.font('Helvetica').fontSize(7).fillColor('#888')
      .text(`${UNI} · Generated ${new Date().toLocaleString()} · Page ${i + 1} of ${range.count}`, left, doc.page.height - 24, { align: 'center', width: w, lineBreak: false });
    doc.page.margins.bottom = oldBottom;
  }
}

/** Bordered table with header repeat on page break. columns: [{header,key,width(pt),align}] */
function table(doc, columns, rows, opts = {}) {
  const x0 = doc.page.margins.left;
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const pad = 3;
  const fontSize = opts.fontSize || 8;
  const HEAD = '#1e3a8a';
  const measure = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    return Math.max(...cells.map((t, i) => doc.heightOfString(String(t), { width: columns[i].width - pad * 2 }))) + pad * 2;
  };
  const drawRow = (cells, { bold = false, fill = null } = {}, isHeader = false) => {
    const h = measure(cells, bold);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 12) {
      doc.addPage();
      if (!isHeader) drawRow(columns.map((c) => c.header), { bold: true, fill: HEAD }, true);
    }
    const y = doc.y;
    if (fill) doc.rect(x0, y, totalW, h).fill(fill);
    let x = x0;
    cells.forEach((t, i) => {
      doc.rect(x, y, columns[i].width, h).lineWidth(0.4).strokeColor('#94a3b8').stroke();
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(fill === HEAD ? '#ffffff' : '#111111')
        .text(String(t), x + pad, y + pad, { width: columns[i].width - pad * 2, align: columns[i].align || 'left' });
      x += columns[i].width;
    });
    doc.y = y + h; doc.x = x0;
  };
  drawRow(columns.map((c) => c.header), { bold: true, fill: HEAD }, true);
  rows.forEach((r, i) => drawRow(columns.map((c) => (r[c.key] == null || r[c.key] === '' ? (r.__bold || r.__fill ? '' : '—') : r[c.key])), { bold: !!r.__bold, fill: r.__fill || (i % 2 ? '#f8fafc' : null) }));
  doc.moveDown(0.6);
}

/** Generic sectioned PDF (stage exports, gazette). Column widths are relative. */
function pdf(res, filename, title, subtitle, sections, opts = {}) {
  const doc = pdfStart(res, filename, opts);
  header(doc, title, subtitle);
  const avail = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  if (!sections.length) doc.font('Helvetica').fontSize(10).text('No records in this scope.', { align: 'center' });
  for (const sec of sections) {
    if (sec.title) {
      if (doc.y > doc.page.height - 130) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY).text(sec.title, { width: avail });
      doc.moveDown(0.2).fillColor('#000');
    }
    const sum = sec.columns.reduce((s, c) => s + (c.width || 14), 0);
    table(doc, sec.columns.map((c) => ({ ...c, width: ((c.width || 14) / sum) * avail })), sec.rows, { fontSize: opts.fontSize });
  }
  footer(doc);
  doc.end();
}

// ---------------- Stage sheets ----------------
const SUBJECT_COLUMNS = [
  { header: '#', key: 'sn', width: 4, align: 'center' },
  { header: 'Roll No', key: 'rollNumber', width: 12 },
  { header: 'Student', key: 'student', width: 20 },
  { header: 'Batch', key: 'batch', width: 10 },
  { header: 'Mid (Obt / Total)', key: 'mid', width: 11, align: 'center' },
  { header: 'Final (Obt / Total)', key: 'final', width: 11, align: 'center' },
  { header: 'Total %', key: 'pct', width: 8, align: 'center' },
  { header: 'Grade', key: 'letterGrade', width: 6, align: 'center' },
  { header: 'GP', key: 'gp', width: 6, align: 'center' },
  { header: 'Sem GPA', key: 'gpa', width: 7, align: 'center' },
  { header: 'CGPA', key: 'cgpa', width: 7, align: 'center' },
  { header: 'Stage', key: 'workflowStage', width: 10, align: 'center' },
];

function subjectRows(rows) {
  return rows.map((r, i) => ({
    ...r, sn: i + 1,
    mid: `${fmt(r.midMarks, 1)} / ${fmt(r.midMax, 0)}`,
    final: `${fmt(r.finalMarks, 1)} / ${fmt(r.finalMax, 0)}`,
    pct: fmt(r.totalPercent), gp: fmt(r.gradePoints), gpa: fmt(r.semesterGpa), cgpa: fmt(r.cgpa),
  }));
}

/** One table per subject: Department › Program › Semester › Subject. */
function scopeSections(rows) {
  const by = {};
  for (const r of rows) (by[`${r.department}|${r.program}|${String(r.semester).padStart(2, '0')}|${r.courseCode}`] ||= []).push(r);
  return Object.entries(by).sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => ({
    title: `${list[0].department} › ${list[0].program} › Semester ${list[0].semester || '—'} › ${list[0].courseCode} ${list[0].courseTitle} (${list[0].creditHours} Cr.)`,
    columns: SUBJECT_COLUMNS,
    rows: subjectRows(list),
  }));
}

// ---------------- Gazette ----------------
const GAZETTE_COLUMNS = [
  { header: 'Code', key: 'code', width: 14 }, { header: 'Course Title', key: 'title', width: 30 },
  { header: 'Cr.', key: 'cr', width: 5, align: 'center' }, { header: 'Mid (Obt/Tot)', key: 'mid', width: 10, align: 'center' },
  { header: 'Final (Obt/Tot)', key: 'final', width: 10, align: 'center' }, { header: '%', key: 'pct', width: 7, align: 'center' },
  { header: 'Grade', key: 'grade', width: 6, align: 'center' }, { header: 'GP / GPA', key: 'gp', width: 8, align: 'center' },
];

function gazetteSections(g) {
  return g.students.map((s) => {
    const rows = [];
    for (const sem of s.semesters) {
      rows.push({ code: `SEMESTER ${sem.semester || '—'}${sem.term ? ` · ${sem.term}` : ''}`, __bold: true, __fill: '#e0e7ff' });
      for (const sub of sem.subjects) {
        rows.push({ code: sub.courseCode, title: sub.courseTitle, cr: sub.creditHours, mid: `${fmt(sub.midMarks, 1)}/${fmt(sub.midMax, 0)}`, final: `${fmt(sub.finalMarks, 1)}/${fmt(sub.finalMax, 0)}`, pct: fmt(sub.totalPercent), grade: sub.letterGrade || '—', gp: fmt(sub.gradePoints) });
      }
      rows.push({ title: `Semester ${sem.semester || '—'} GPA  (${sem.stage})`, cr: sem.credits, gp: fmt(sem.gpa), __bold: true });
    }
    rows.push({ title: 'CGPA', gp: fmt(s.cgpa), __bold: true, __fill: '#dcfce7' });
    return {
      title: `${s.rollNumber} — ${s.student}${s.fatherName ? ` s/o ${s.fatherName}` : ''} · ${s.program}${s.registrationNumber ? ` · Reg# ${s.registrationNumber}` : ''}`,
      columns: GAZETTE_COLUMNS,
      rows,
    };
  });
}

module.exports = {
  UNI, NAVY, LOGO, fmt, safeName,
  excel, pdf, pdfStart, header, footer, table,
  SUBJECT_COLUMNS, subjectRows, scopeSections, GAZETTE_COLUMNS, gazetteSections,
};
