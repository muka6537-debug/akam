import { Fragment, useMemo, useState } from "react";
import { Award, ChevronDown, Download, FileText, Loader2, Lock, RefreshCw, ShieldCheck, Hourglass, CalendarClock } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import useApi from "../../hooks/useApi";
import useRealtime from "../../hooks/useRealtime";
import api from "../../services/api";
import { useToast } from "../../context/ToastContext";

/* =============================================================
   Student — Results & Transcripts (A6 / A10)
   • All subjects across all enrolled semesters, grouped by semester.
   • Before a semester's unofficial result is declared: only the raw
     marks uploaded by teachers (Obtained / Total + weightage) — no
     grade, GPA or transcript. This is informational, not the result.
   • After UNOFFICIAL declaration: grade, GPA, running CGPA and the
     unofficial transcript (download) for that semester.
   • After OFFICIAL declaration: the official transcript.
   • Gating is per semester and independent.
   • Updates in real time as teachers grade.
   ============================================================= */
const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const STATUS = {
  IN_PROGRESS: { label: "Result not declared", icon: Hourglass, cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" },
  UNOFFICIAL: { label: "Unofficial result declared", icon: FileText, cls: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" },
  OFFICIAL: { label: "Official result", icon: ShieldCheck, cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" },
};

function Breakdown({ b }) {
  if (!b || !b.components?.length) return <p className="text-xs text-muted-app">No assessment plan configured yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase text-slate-500">
            <th className="px-2 py-1.5 text-left">Assessment</th>
            <th className="px-2 py-1.5 text-center">Obtained / Total</th>
            <th className="px-2 py-1.5 text-center">Weightage</th>
            <th className="px-2 py-1.5 text-center">Converted</th>
          </tr>
        </thead>
        <tbody>
          {b.components.map((c) => (
            <tr key={c.key} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-2 py-1.5 font-semibold text-app">{c.label}</td>
              <td className="px-2 py-1.5 text-center">{c.obtained == null ? <span className="text-slate-400">Pending</span> : `${c.obtained} / ${c.total ?? "—"}`}</td>
              <td className="px-2 py-1.5 text-center">{fmt(c.weight)}%</td>
              <td className="px-2 py-1.5 text-center font-bold text-primary-700 dark:text-primary-300">{c.weightedMarks == null ? "—" : fmt(c.weightedMarks)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-200 dark:border-slate-700 font-bold">
            <td className="px-2 py-1.5">Total so far</td><td /><td className="px-2 py-1.5 text-center">{fmt(b.totalWeight)}</td>
            <td className="px-2 py-1.5 text-center text-primary-700 dark:text-primary-300">{fmt(b.weightedTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function Results() {
  const { toast } = useToast();
  const { data, loading, error, reload } = useApi(() => api.student.resultRecord(), []);
  const [active, setActive] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [busy, setBusy] = useState(null);

  // Real-time: grading / declarations push an update.
  useRealtime(api.student.eventsUrl, { result: () => reload(), weightage: () => reload() }, []);

  const semesters = useMemo(() => data?.semesters || [], [data]);
  const current = semesters.find((s) => s.semester === active) || semesters[semesters.length - 1] || null;

  const dl = async (kind, semester) => {
    setBusy(`${kind}-${semester || "all"}`);
    try { await api.student.downloadTranscriptPdf(kind, semester); }
    catch (e) { toast(e.message, { type: "error" }); }
    finally { setBusy(null); }
  };

  if (loading) return <div><PageHeader title="Results & Transcripts" icon="Award" /><Skeleton className="h-64 w-full rounded-2xl" /></div>;

  const declared = semesters.filter((s) => s.declared);
  const anyOfficial = semesters.some((s) => s.official);

  return (
    <div>
      <PageHeader
        title="Results & Transcripts"
        subtitle="Semester-wise marks, GPA, CGPA and transcripts"
        icon="Award"
        breadcrumb={["Dashboard", "Results"]}
        actions={
          <div className="flex flex-wrap gap-2">
            <button onClick={reload} className="btn-secondary text-sm"><RefreshCw size={14} /> Refresh</button>
            <button disabled={!declared.length || !!busy} onClick={() => dl("unofficial")} className="btn-secondary text-sm disabled:opacity-50">{busy === "unofficial-all" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Unofficial Transcript</button>
            <button disabled={!anyOfficial || !!busy} onClick={() => dl("official")} className="btn-primary text-sm disabled:opacity-50">{busy === "official-all" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Official Transcript</button>
          </div>
        }
      />

      {error ? <ErrorState description={error} onRetry={reload} /> : !semesters.length ? (
        <EmptyState icon="Award" title="No courses yet" description="Your results appear here automatically once you are enrolled in courses." />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <div className="card-base p-4"><p className="text-[11px] uppercase font-bold text-muted-app">Batch</p><p className="font-bold text-app text-lg">{data.profile?.batch || "—"}</p></div>
            <div className="card-base p-4"><p className="text-[11px] uppercase font-bold text-muted-app flex items-center gap-1"><CalendarClock size={11} /> Current Session</p><p className="font-bold text-app text-lg">{data.currentSession || "—"}</p></div>
            <div className="card-base p-4"><p className="text-[11px] uppercase font-bold text-muted-app">CGPA</p><p className="font-bold text-primary-700 dark:text-primary-300 text-2xl">{data.cgpa != null ? fmt(data.cgpa) : "—"}</p><p className="text-[10px] text-muted-app">{declared.length ? `through Semester ${declared[declared.length - 1].semester}` : "after the first declared result"}</p></div>
            <div className="card-base p-4"><p className="text-[11px] uppercase font-bold text-muted-app">Credits earned</p><p className="font-bold text-app text-lg">{data.creditsEarned || 0}</p></div>
          </div>

          <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar">
            {semesters.map((s) => {
              const st = STATUS[s.status];
              return (
                <button key={s.semester} onClick={() => setActive(s.semester)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap flex items-center gap-1.5 ${current?.semester === s.semester ? "bg-primary-600 text-white shadow-lg" : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"}`}>
                  <st.icon size={13} /> Semester {s.semester}
                </button>
              );
            })}
          </div>

          {current && (() => {
            const st = STATUS[current.status];
            return (
              <div className="card-base overflow-hidden">
                <div className="px-5 py-4 bg-gradient-to-r from-primary-50 to-blue-50 dark:from-slate-800 dark:to-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-display font-bold text-lg text-app">Semester {current.semester}{current.term ? ` · ${current.term}` : ""}</p>
                    <p className="text-xs text-muted-app">{current.subjects.length} subject(s) · {current.credits} credit hours</p>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-xs font-semibold inline-flex items-center gap-1 ${st.cls}`}><st.icon size={12} /> {st.label}</span>
                  {current.declared && (
                    <div className="flex gap-2">
                      <button onClick={() => dl("unofficial", current.semester)} disabled={!!busy} className="btn-secondary text-xs">{busy === `unofficial-${current.semester}` ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Unofficial transcript</button>
                      {current.official && <button onClick={() => dl("official", current.semester)} disabled={!!busy} className="btn-primary text-xs">{busy === `official-${current.semester}` ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Official transcript</button>}
                    </div>
                  )}
                </div>

                {!current.declared && (
                  <div className="px-5 py-3 text-xs text-amber-800 dark:text-amber-200 bg-amber-50/70 dark:bg-amber-950/20 flex items-center gap-2">
                    <Lock size={13} /> Live marks uploaded by your teachers — for information only. Grades, GPA and the transcript for this semester appear once the Exam Controller declares the result.
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-900 text-[11px] uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Code</th><th className="px-3 py-2 text-left">Course</th><th className="px-3 py-2 text-center">Cr.</th>
                        <th className="px-3 py-2 text-center">Mid (Obt / Total)</th><th className="px-3 py-2 text-center">Final (Obt / Total)</th>
                        <th className="px-3 py-2 text-center">Marks</th>
                        {current.declared && <><th className="px-3 py-2 text-center">Grade</th><th className="px-3 py-2 text-center">GP</th></>}
                      </tr>
                    </thead>
                    <tbody>
                      {current.subjects.map((x) => {
                        const b = x.breakdown;
                        const mid = b?.components?.find((c) => c.category === "mid");
                        const fin = b?.components?.find((c) => c.category === "final");
                        const open = !!expanded[x.offeringId];
                        return (
                          <Fragment key={x.offeringId}>
                            <tr className="border-t border-slate-100 dark:border-slate-800">
                              <td className="px-3 py-2.5 font-mono font-bold text-primary-700 dark:text-primary-300">{x.courseCode}</td>
                              <td className="px-3 py-2.5 font-semibold text-app">
                                {x.courseTitle}
                                <button onClick={() => setExpanded((m) => ({ ...m, [x.offeringId]: !m[x.offeringId] }))} className="ml-2 text-[11px] text-primary-600 hover:underline inline-flex items-center gap-0.5">
                                  {open ? "Hide" : "View"} marks <ChevronDown size={12} className={open ? "rotate-180" : ""} />
                                </button>
                              </td>
                              <td className="px-3 py-2.5 text-center">{x.creditHours}</td>
                              <td className="px-3 py-2.5 text-center">{mid ? (mid.obtained == null ? "Pending" : `${mid.obtained} / ${mid.total ?? x.midTotalMarks ?? "—"}`) : "—"}</td>
                              <td className="px-3 py-2.5 text-center">{fin ? (fin.obtained == null ? "Pending" : `${fin.obtained} / ${fin.total ?? x.finalTotalMarks ?? "—"}`) : "—"}</td>
                              <td className="px-3 py-2.5 text-center font-bold">{b ? `${fmt(b.weightedTotal)} / ${fmt(b.totalWeight, 0)}` : "—"}</td>
                              {current.declared && <><td className="px-3 py-2.5 text-center font-bold text-primary-700 dark:text-primary-300">{x.letterGrade}</td><td className="px-3 py-2.5 text-center">{fmt(x.gradePoints)}</td></>}
                            </tr>
                            {open && <tr className="bg-slate-50/60 dark:bg-slate-900/40"><td colSpan={current.declared ? 8 : 6} className="px-5 py-3"><Breakdown b={b} /></td></tr>}
                          </Fragment>
                        );
                      })}
                    </tbody>
                    {current.declared && (
                      <tfoot>
                        <tr className="bg-gradient-to-r from-primary-50 to-blue-50 dark:from-slate-800 dark:to-slate-800 font-bold">
                          <td colSpan={2} className="px-3 py-3">Semester GPA <span className="text-primary-700 dark:text-primary-300 ml-1">{fmt(current.gpa)}</span></td>
                          <td className="px-3 py-3 text-center">{current.credits}</td>
                          <td colSpan={3} className="px-3 py-3 text-right">Cumulative CGPA</td>
                          <td colSpan={2} className="px-3 py-3 text-center text-primary-700 dark:text-primary-300">{fmt(current.cgpa)}</td>
                        </tr>
                        {current.probation?.onProbation && (
                          <tr><td colSpan={8} className="px-3 py-2 text-xs font-semibold text-rose-700 bg-rose-50 dark:bg-rose-500/10">Academic standing: {current.probation.label} (semester GPA below {current.probation.threshold.toFixed(2)})</td></tr>
                        )}
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            );
          })()}
          <p className="text-[11px] text-muted-app mt-3 flex items-center gap-1"><Award size={12} /> GPA = Σ(credit hours × grade point) ÷ semester credit hours · CGPA across all declared semesters (official AUST scale).</p>
        </>
      )}
    </div>
  );
}
