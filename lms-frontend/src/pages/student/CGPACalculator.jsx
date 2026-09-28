import { useMemo, useState } from "react";
import { Calculator, TrendingUp, GraduationCap, History, Info, RotateCcw, Radio } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import useApi from "../../hooks/useApi";
import useRealtime from "../../hooks/useRealtime";
import api from "../../services/api";
import { gradeFromPercent, computeGPA, GRADE_BANDS, MIN_CGPA } from "../../utils/austGrading";

/* =============================================================
   CGPA Calculator (B1.a) — official AUST scale + formulas (A12).
   • Declared semesters feed the cumulative base automatically.
   • Current (undeclared) courses are pre-filled from the LIVE marks
     your teachers have entered and update in real time; you can
     override any course with an expected percentage to project.
   GPA  = Σ(Credit Hours × Grade Point) ÷ Semester Credit Hours
   CGPA = Σ(Credit Hours × Grade Point, all semesters) ÷ Total Credit Hours
   ============================================================= */
const fmt = (v) => (v == null ? "—" : Number(v).toFixed(2));

export default function CGPACalculator() {
  const { data, loading, error, reload } = useApi(() => api.student.resultRecord(), []);
  const [overrides, setOverrides] = useState({}); // offeringId → percent string
  useRealtime(api.student.eventsUrl, { result: () => reload(), weightage: () => reload() }, []);

  const level = data?.level || "UG";
  const declared = useMemo(() => (data?.semesters || []).filter((s) => s.declared), [data]);
  const pending = useMemo(() => (data?.semesters || []).filter((s) => !s.declared), [data]);

  const base = useMemo(() => computeGPA(declared.flatMap((s) => s.subjects)), [declared]);

  const projected = useMemo(() => pending.map((sem) => {
    const rows = sem.subjects.map((x) => {
      const b = x.breakdown;
      const livePct = b && b.totalWeight > 0 ? (b.weightedTotal / b.totalWeight) * 100 : null;
      const ov = overrides[x.offeringId];
      const pct = ov !== undefined && ov !== "" ? Number(ov) : livePct;
      const g = pct == null || Number.isNaN(pct) ? null : gradeFromPercent(pct, level);
      return { ...x, livePct, pct, letterGrade: g?.letter, gradePoints: g ? g.points : null, graded: b ? b.components.filter((c) => c.weightedMarks != null).length : 0, total: b ? b.components.length : 0 };
    });
    return { ...sem, rows, calc: computeGPA(rows) };
  }), [pending, overrides, level]);

  const all = useMemo(() => {
    const rows = [...declared.flatMap((s) => s.subjects), ...projected.flatMap((s) => s.rows)];
    return computeGPA(rows);
  }, [declared, projected]);

  if (loading) return <div><PageHeader title="CGPA Calculator" icon="Calculator" /><Skeleton className="h-64 w-full rounded-2xl" /></div>;
  if (error) return <ErrorState description={error} onRetry={reload} />;
  if (!data?.semesters?.length) return <div><PageHeader title="CGPA Calculator" icon="Calculator" /><EmptyState icon="Calculator" title="No courses yet" description="Your courses will appear here once you are enrolled." /></div>;

  const min = MIN_CGPA[level] || 2;
  return (
    <div>
      <PageHeader title="CGPA Calculator" subtitle="Official AUST grading scale — updates live as your teachers enter marks" icon="Calculator" breadcrumb={["Dashboard", "CGPA Calculator"]}
        actions={<button onClick={() => setOverrides({})} className="btn-secondary text-sm"><RotateCcw size={14} /> Reset projections</button>} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div className="card-base p-5"><p className="text-xs font-bold uppercase text-muted-app flex items-center gap-1"><History size={12} /> Declared CGPA</p><p className="text-3xl font-bold text-app mt-1">{declared.length ? fmt(base.gpa) : "—"}</p><p className="text-xs text-muted-app">{base.credits} credit hours · {declared.length} declared semester(s)</p></div>
        <div className="card-base p-5"><p className="text-xs font-bold uppercase text-muted-app flex items-center gap-1"><TrendingUp size={12} /> Projected CGPA</p><p className="text-3xl font-bold text-primary-700 dark:text-primary-300 mt-1">{fmt(all.gpa)}</p><p className="text-xs text-muted-app">{all.credits} credit hours incl. current semester</p></div>
        <div className="card-base p-5"><p className="text-xs font-bold uppercase text-muted-app flex items-center gap-1"><GraduationCap size={12} /> Degree requirement</p><p className="text-3xl font-bold text-app mt-1">{min.toFixed(2)}</p><p className={`text-xs font-semibold ${all.gpa >= min ? "text-emerald-600" : "text-rose-600"}`}>{all.gpa >= min ? "On track" : "Below the minimum CGPA"}</p></div>
      </div>

      {projected.map((sem) => (
        <div key={sem.semester} className="card-base overflow-hidden mb-4">
          <div className="px-4 py-3 bg-slate-50 dark:bg-slate-900 flex flex-wrap items-center justify-between gap-2">
            <p className="font-bold text-app flex items-center gap-2"><Radio size={14} className="text-rose-500" /> Semester {sem.semester} (in progress)</p>
            <p className="text-sm font-bold">Projected GPA <span className="text-primary-700 dark:text-primary-300">{fmt(sem.calc.gpa)}</span></p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase text-slate-500"><tr>
                <th className="px-3 py-2 text-left">Course</th><th className="px-3 py-2 text-center">Cr.</th><th className="px-3 py-2 text-center">Live marks</th>
                <th className="px-3 py-2 text-center">Expected %</th><th className="px-3 py-2 text-center">Grade</th><th className="px-3 py-2 text-center">GP</th><th className="px-3 py-2 text-center">Cr × GP</th>
              </tr></thead>
              <tbody>
                {sem.rows.map((r) => (
                  <tr key={r.offeringId} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2"><span className="font-mono text-xs text-primary-700 dark:text-primary-300">{r.courseCode}</span> <span className="font-semibold text-app">{r.courseTitle}</span></td>
                    <td className="px-3 py-2 text-center">{r.creditHours}</td>
                    <td className="px-3 py-2 text-center text-xs">{r.livePct == null ? "—" : `${r.livePct.toFixed(1)}%`}<div className="text-[10px] text-muted-app">{r.graded}/{r.total} assessed</div></td>
                    <td className="px-3 py-2 text-center"><input type="number" min="0" max="100" value={overrides[r.offeringId] ?? ""} placeholder={r.livePct == null ? "%" : r.livePct.toFixed(0)} onChange={(e) => setOverrides((o) => ({ ...o, [r.offeringId]: e.target.value }))} className="input-base w-20 text-center text-sm py-1" /></td>
                    <td className="px-3 py-2 text-center font-bold">{r.letterGrade || "—"}</td>
                    <td className="px-3 py-2 text-center">{fmt(r.gradePoints)}</td>
                    <td className="px-3 py-2 text-center">{r.gradePoints == null ? "—" : fmt(r.gradePoints * r.creditHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {declared.length > 0 && (
        <div className="card-base overflow-hidden mb-4">
          <p className="px-4 py-3 font-bold text-app bg-slate-50 dark:bg-slate-900">Declared semesters</p>
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-slate-500"><tr><th className="px-3 py-2 text-left">Semester</th><th className="px-3 py-2 text-center">Credits</th><th className="px-3 py-2 text-center">GPA</th><th className="px-3 py-2 text-center">CGPA</th><th className="px-3 py-2 text-center">Status</th></tr></thead>
            <tbody>{declared.map((s) => (
              <tr key={s.semester} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2 font-semibold">Semester {s.semester}</td><td className="px-3 py-2 text-center">{s.credits}</td>
                <td className="px-3 py-2 text-center font-bold">{fmt(s.gpa)}</td><td className="px-3 py-2 text-center font-bold text-primary-700 dark:text-primary-300">{fmt(s.cgpa)}</td>
                <td className="px-3 py-2 text-center text-xs">{s.official ? "Official" : "Unofficial"}{s.probation?.onProbation ? ` · ${s.probation.label}` : ""}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      <div className="card-base p-4">
        <p className="font-bold text-app text-sm mb-2 flex items-center gap-1"><Info size={14} /> Official AUST grading scale</p>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
          {GRADE_BANDS.map((g, i) => (
            <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-800 p-2"><p className="font-bold text-app">{g.grade} · {g.points}</p><p className="text-muted-app">{g.range}</p><p className="text-[10px] text-muted-app">{g.remarks}</p></div>
          ))}
        </div>
        <p className="text-[11px] text-muted-app mt-3 flex items-center gap-1"><Calculator size={12} /> Grade points step by 0.1 per mark between 50% (1.0) and 79% (3.9); 80% and above earns 4.00. Minimum CGPA: 2.00 Bachelor's, 2.50 MS/MPhil. A semester GPA below the minimum places the student on probation the following semester.</p>
      </div>
    </div>
  );
}
