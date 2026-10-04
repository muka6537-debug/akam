// Excel / PDF export for fee lists, and the printable challan voucher.
// A report is { title, subtitle, columns: [{ header, key, width, money }], rows }.
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const LOGO = path.join(__dirname, '..', '..', 'assets', 'aust-logo.jpg');
const UNI = 'Abbottabad University of Science & Technology';
const OFFICE = 'Open & Distance Learning — Fee Office';
const NAVY = '#1e3a8a';

const fileName = (s) => String(s || 'report').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 80);
const pkr = (n) => Number(n || 0).toLocaleString('en-PK');

function value(col, row) {
  const v = row[col.key];
  if (v == null || v === '') return '';
  return col.money ? Number(v) : v;
}

function text(col, row) {
  const v = value(col, row);
  if (v === '') return '—';
  return col.money ? pkr(v) : String(v);
}

async function toExcel(res, report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = UNI;
  const ws = wb.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: 4 }] });
  const width = report.columns.length;
  [[UNI, 14, true], [report.title, 12, true], [report.subtitle || '', 9, false]].forEach(([t, size, bold]) => {
    const r = ws.addRow([t]);
    ws.mergeCells(r.number, 1, r.number, width);
    r.font = { bold, size, color: { argb: 'FF1E3A8A' } };
    r.alignment = { horizontal: 'center' };
  });
  const head = ws.addRow(report.columns.map((c) => c.header));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }; });
  for (const row of report.rows) ws.addRow(report.columns.map((c) => value(c, row)));
  report.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width || 16;
    if (c.money) col.numFmt = '#,##0';
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(report.title)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

function header(doc, title, subtitle) {
  const left = doc.page.margins.left;
  const w = doc.page.width - left - doc.page.margins.right;
  const top = doc.page.margins.top;
  if (fs.existsSync(LOGO)) { try { doc.image(LOGO, left, top - 6, { width: 42 }); } catch (_) { /* unreadable logo */ } }
  doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text(UNI, left, top, { align: 'center', width: w });
  doc.font('Helvetica').fontSize(9).fillColor('#444').text(OFFICE, { align: 'center', width: w });
  doc.moveDown(0.3).font('Helvetica-Bold').fontSize(12).fillColor('#111').text(title, { align: 'center', width: w });
  if (subtitle) doc.font('Helvetica').fontSize(9).fillColor('#555').text(subtitle, { align: 'center', width: w });
  const y = Math.max(doc.y + 4, top + 48);
  doc.moveTo(left, y).lineTo(left + w, y).lineWidth(1).strokeColor(NAVY).stroke();
  doc.y = y + 8;
  doc.x = left;
  doc.fillColor('#000');
}

function table(doc, columns, rows) {
  const left = doc.page.margins.left;
  const avail = doc.page.width - left - doc.page.margins.right;
  const sum = columns.reduce((s, c) => s + (c.width || 16), 0);
  const cols = columns.map((c) => ({ ...c, w: ((c.width || 16) / sum) * avail }));
  const pad = 3;
  const draw = (cells, isHead, shade) => {
    doc.font(isHead ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: cols[i].w - pad * 2 }))) + pad * 2;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 14) {
      doc.addPage();
      if (!isHead) draw(cols.map((c) => c.header), true);
    }
    const y = doc.y;
    if (isHead) doc.rect(left, y, avail, h).fill(NAVY);
    else if (shade) doc.rect(left, y, avail, h).fill('#f1f5f9');
    let x = left;
    cells.forEach((t, i) => {
      doc.rect(x, y, cols[i].w, h).lineWidth(0.4).strokeColor('#94a3b8').stroke();
      doc.font(isHead ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(isHead ? '#fff' : '#111')
        .text(t, x + pad, y + pad, { width: cols[i].w - pad * 2, align: cols[i].money && !isHead ? 'right' : 'left' });
      x += cols[i].w;
    });
    doc.y = y + h;
    doc.x = left;
  };
  draw(cols.map((c) => c.header), true);
  rows.forEach((r, i) => draw(cols.map((c) => text(c, r)), false, i % 2 === 1));
}

function toPdf(res, report) {
  const doc = new PDFDocument({ size: 'A4', layout: report.columns.length > 7 ? 'landscape' : 'portrait', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(report.title)}.pdf"`);
  doc.pipe(res);
  header(doc, report.title, report.subtitle);
  if (!report.rows.length) doc.font('Helvetica').fontSize(10).text('No records match the selected filters.', { align: 'center' });
  else table(doc, report.columns, report.rows);
  doc.end();
}

const send = (res, report, format) => (String(format).toLowerCase() === 'pdf' ? toPdf(res, report) : toExcel(res, report));

function challanPdf(res, c, student) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(c.challanNo)}.pdf"`);
  doc.pipe(res);
  header(doc, 'Fee Challan', `${c.challanNo} · ${c.title}`);
  const line = (k, v) => doc.font('Helvetica-Bold').fontSize(9).text(`${k}: `, { continued: true }).font('Helvetica').text(v || '—');
  line('Student', `${student.fullName || ''} (${student.rollNumber || ''})`);
  line('Program / Batch', `${student.programName || student.program || ''} — ${c.batch || student.batch || ''}`);
  line('Semester', String(c.semester ?? '—'));
  line('Due Date', c.dueDate);
  line('Status', c.status);
  doc.moveDown(0.6);
  table(doc, [
    { header: 'Fee Head', key: 'label', width: 40 },
    { header: 'Amount', key: 'amount', width: 18, money: true },
    { header: 'Concession', key: 'concession', width: 18, money: true },
    { header: 'Net', key: 'net', width: 18, money: true },
  ], c.lineItems.map((l) => ({ ...l, concession: l.concession || 0, net: l.net ?? l.amount })));
  doc.moveDown(0.6);
  line('Total after concessions', `Rs. ${pkr(c.totalAmount)}`);
  if (c.lateFee) line('Late fee', `Rs. ${pkr(c.lateFee)}`);
  line('Paid', `Rs. ${pkr(c.paidAmount)}`);
  line('Remaining', `Rs. ${pkr(c.remaining)}`);
  doc.end();
}

function admitCardPdf(res, { student, term, courses, exams }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Admit-Card-${fileName(student.rollNumber)}.pdf"`);
  doc.pipe(res);
  header(doc, 'Examination Admit Card', term ? term.title : '');
  const line = (k, v) => doc.font('Helvetica-Bold').fontSize(10).text(`${k}: `, { continued: true }).font('Helvetica').text(v || '—');
  line('Name', student.fullName);
  line('Roll No', student.rollNumber);
  line('Registration No', student.registrationNumber);
  line('Program', student.programName || student.program);
  line('Batch / Semester', `${student.batch} — Semester ${student.semester}`);
  doc.moveDown(0.6);
  table(doc, [
    { header: 'Course Code', key: 'code', width: 16 },
    { header: 'Course Title', key: 'title', width: 40 },
    { header: 'Exam', key: 'exam', width: 30 },
  ], courses.map((c) => ({ ...c, exam: exams[c.offeringId] || 'As per date sheet' })));
  doc.moveDown(1.2).font('Helvetica').fontSize(8).fillColor('#555')
    .text('Fee dues verified clear at the time of issue. Bring this card and your CNIC to every paper.', { align: 'center' });
  doc.end();
}

module.exports = { send, challanPdf, admitCardPdf };
