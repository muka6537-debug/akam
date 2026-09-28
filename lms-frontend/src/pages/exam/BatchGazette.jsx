import { useMemo, useState } from "react";
import { Users, FileSpreadsheet, FileDown, Loader2, Search, CalendarClock, GraduationCap, RefreshCw } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useToast } from "../../context/ToastContext";

/* =============================================================
   Gazette (A11) — organised by BATCH.
   Batch = the admission session a cohort enrolled under (fixed for
   life, e.g. "Batch: Fall 2026"); the current Session is shown
   separately. Every student block lists Semester 1, 2, … with
   subjects, marks and GPA, and CGPA at the end. Builds progressively
   as results move Compilation → Unofficial → Official.
   ============================================================= */
const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const STAGE_CLS = {
  OFFICIAL: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  UNOFFICIAL: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
  COMPILED: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
};

function GazetteView({ batch }) {
  const { toast } = useToast();
  const { data, loading, error, reload } = useApi(() => api.workflow.gazette(batch), [batch]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(null);
  const students = useMemo(() => {
    const list = data?.students || [];
    if (!q.trim()) return list;
    const t = q.toLowerCase();
    return list.filter((s) => [s.student, s.rollNumber, s.registrationNumber].filter(Boolean).some((v) => String(v).toLowerCase().includes(t)));
  }, [data, q]);
  const exp = async (format) => {
    setBusy(format);
    try { await api.workflow.exportGazette(batch, format); } catch (e) { toast(e.message, { type: "error" }); } finally { setBusy(null); }
  };

  if (loading) return <Skeleton className="h-64 w-full rounded-2xl" />;
  if (error) return <ErrorState description={error} onRetry={reload} />;
  return (
    <div className="space-y-4">
      <div className="card-base p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <p className="font-display font-bold text-lg text-app">Batch: {data.batch}</p>
          <p className="text-xs text-muted-app flex items-center gap-1"><CalendarClock size={12} /> Current Session: {data.currentSession || "—"} · {data.students.length} student(s)</p>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / roll no" className="input-base pl-9 text-sm w-56" />
        </div>
        <button onClick={reload} className="btn-secondary text-sm"><RefreshCw size={14} /></button>
        <button onClick={() => exp("excel")} disabled={!!busy} className="btn-secondary text-sm">{busy === "excel" ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} className="text-emerald-600" />} Excel</button>
        <button onClick={() => exp("pdf")} disabled={!!busy} className="btn-secondary text-sm">{busy === "pdf" ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} className="text-rose-600" />} PDF</button>
      </div>

      {students.map((s) => (
        <div key={s.studentId} className="card-base overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 dark:bg-slate-900 flex flex-wrap items-center gap-2 justify-between">
            <div>
              <p className="font-bold text-app"><span className="font-mono text-primary-700 dark:text-primary-300">{s.rollNumber}</span> — {s.student}{s.fatherName ? <span className="font-normal text-muted-app"> s/o {s.fatherName}</span> : null}</p>
              <p className="text-xs text-muted-app">{s.program} · {s.department}{s.registrationNumber ? ` · Reg# ${s.registrationNumber}` : ""}</p>
            </div>
            <span className="text-sm font-bold text-primary-700 dark:text-primary-300">CGPA {fmt(s.cgpa)}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase text-slate-500">
                <tr>{["Code", "Course Title", "Cr.", "Mid (Obt/Total)", "Final (Obt/Total)", "%", "Grade", "GP"].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
              </thead>
              <tbody>
                {s.semesters.map((sem) => [
                  <tr key={`h${sem.semester}`} className="bg-primary-50/60 dark:bg-primary-500/5">
                    <td colSpan={8} className="px-3 py-1.5 text-xs font-bold text-primary-800 dark:text-primary-200">
                      Semester {sem.semester ?? "—"}{sem.term ? ` · ${sem.term}` : ""}
                      <span className={`ml-2 text-[10px] px-2 py-0.5 rounded-full ${STAGE_CLS[sem.stage]}`}>{sem.stage}</span>
                    </td>
                  </tr>,
                  ...sem.subjects.map((x) => (
                    <tr key={`${sem.semester}-${x.courseCode}`} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-1.5 font-mono text-xs">{x.courseCode}</td>
                      <td className="px-3 py-1.5">{x.courseTitle}</td>
                      <td className="px-3 py-1.5">{x.creditHours}</td>
                      <td className="px-3 py-1.5">{fmt(x.midMarks, 1)} / {fmt(x.midMax, 0)}</td>
                      <td className="px-3 py-1.5">{fmt(x.finalMarks, 1)} / {fmt(x.finalMax, 0)}</td>
                      <td className="px-3 py-1.5">{fmt(x.totalPercent)}</td>
                      <td className="px-3 py-1.5 font-bold">{x.letterGrade}</td>
                      <td className="px-3 py-1.5">{fmt(x.gradePoints)}</td>
                    </tr>
                  )),
                  <tr key={`g${sem.semester}`} className="border-t border-slate-200 dark:border-slate-700 font-semibold">
                    <td colSpan={2} className="px-3 py-1.5 text-right text-xs">Semester {sem.semester} GPA</td>
                    <td className="px-3 py-1.5">{sem.credits}</td>
                    <td colSpan={4} />
                    <td className="px-3 py-1.5 text-primary-700 dark:text-primary-300">{fmt(sem.gpa)}</td>
                  </tr>,
                ])}
                <tr className="bg-emerald-50/70 dark:bg-emerald-500/5 font-bold">
                  <td colSpan={7} className="px-3 py-2 text-right">CGPA</td>
                  <td className="px-3 py-2 text-emerald-700 dark:text-emerald-300">{fmt(s.cgpa)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {!students.length && <EmptyState icon="Users" title="No matching students" description="Try a different search." />}
    </div>
  );
}

export default function BatchGazette() {
  const { data, loading, error, reload } = useApi(() => api.workflow.gazetteBatches(), []);
  const [batch, setBatch] = useState(null);
  const batches = data?.batches || [];
  return (
    <div>
      <PageHeader title="Gazette" subtitle="Batch-wise result gazette — builds automatically as results are compiled and declared" icon="BookCheck" breadcrumb={["Exam Controller", "Gazette"]} />
      {loading ? <Skeleton className="h-40 w-full rounded-2xl" /> : error ? <ErrorState description={error} onRetry={reload} /> : !batches.length ? (
        <EmptyState icon="BookCheck" title="No gazette yet" description="The gazette becomes available once teachers submit results for a batch." />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            {batches.map((b) => (
              <button key={b.batch} onClick={() => setBatch(b.batch)} className={`card-base p-4 text-left transition ${batch === b.batch ? "border-primary-500 ring-2 ring-primary-200 dark:ring-primary-900" : "hover:border-primary-300"}`}>
                <p className="text-[11px] font-bold uppercase text-muted-app">Batch</p>
                <p className="font-display font-bold text-lg text-app">{b.batch}</p>
                <p className="text-xs text-muted-app mt-1 flex items-center gap-1"><Users size={12} /> {b.students} students · <GraduationCap size={12} /> {b.programs.join(", ") || "—"}</p>
                <p className="text-[11px] text-muted-app mt-1">Current session: {b.currentSession || "—"}</p>
              </button>
            ))}
          </div>
          {batch ? <GazetteView key={batch} batch={batch} /> : <p className="text-sm text-muted-app">Select a batch to view its gazette.</p>}
        </>
      )}
    </div>
  );
}
