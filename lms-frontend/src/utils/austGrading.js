// ============================================================
//  OFFICIAL AUST GRADING (frontend mirror of backend/src/utils/lmsGrading.js)
//  Single table used by the CGPA calculator and any client-side preview.
//  Grade points are per-percent from 50 to 79 and 4.00 from 80 upward;
//  percentages are rounded to the nearest whole mark before lookup.
// ============================================================
export const FAIL_BELOW = { UG: 50, MS: 50, MPHIL: 60, PHD: 65 };

export const GRADE_BANDS = [
  { grade: "A", range: "90 & above", points: "4.00", remarks: "Excellent" },
  { grade: "A", range: "85–89", points: "4.00", remarks: "Very Good" },
  { grade: "A-", range: "80–84", points: "4.00", remarks: "Very Good" },
  { grade: "B", range: "73–79", points: "3.3–3.9", remarks: "Good" },
  { grade: "B-", range: "70–72", points: "3.0–3.2", remarks: "Good" },
  { grade: "C", range: "63–69", points: "2.3–2.9", remarks: "Satisfactory" },
  { grade: "C-", range: "60–62", points: "2.0–2.2", remarks: "Satisfactory" },
  { grade: "D", range: "50–59", points: "1.0–1.9", remarks: "Pass" },
  { grade: "F", range: "0–49 (MPhil 0–59, PhD 0–64)", points: "0", remarks: "Fail" },
  { grade: "W", range: "Withdrawn course", points: "—", remarks: "Withdrawn" },
  { grade: "I", range: "Incomplete course", points: "—", remarks: "Incomplete" },
];

export function gradeFromPercent(percent, level = "UG") {
  const raw = Math.max(0, Math.min(100, Number(percent) || 0));
  const p = Math.round(raw);
  if (p < (FAIL_BELOW[level] || 50)) return { letter: "F", points: 0 };
  if (p >= 80) return { letter: p >= 85 ? "A" : "A-", points: 4 };
  const points = Math.round((p / 10 - 4) * 10) / 10; // 79→3.9 … 50→1.0
  let letter = "D";
  if (p >= 73) letter = "B"; else if (p >= 70) letter = "B-"; else if (p >= 63) letter = "C"; else if (p >= 60) letter = "C-";
  return { letter, points };
}

/** Σ(credit × GP) ÷ Σ credit (W / I excluded). */
export function computeGPA(rows) {
  let qp = 0; let cr = 0;
  for (const r of rows || []) {
    const g = String(r.letterGrade || "").toUpperCase();
    if (g === "W" || g === "I" || r.gradePoints == null) continue;
    const c = Number(r.creditHours) || 0;
    qp += (Number(r.gradePoints) || 0) * c;
    cr += c;
  }
  return { gpa: cr ? Math.round((qp / cr) * 100) / 100 : 0, credits: cr, qualityPoints: qp };
}

export const MIN_CGPA = { UG: 2.0, MS: 2.5, MPHIL: 2.5, PHD: 2.5 };
