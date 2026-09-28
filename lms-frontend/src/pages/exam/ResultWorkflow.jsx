import { useMemo, useState } from "react";
import { Building2, GraduationCap, Layers, BookOpen, ChevronRight, FileSpreadsheet, FileDown, Loader2, Megaphone, Lock, ShieldCheck, Home, RefreshCw } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useToast } from "../../context/ToastContext";

/* =============================================================
   Exam Controller — Result Workflow (A9)
   Four sequential stages, each navigated by click-through
   Department → Program → Semester → Subject (no flat dropdowns):
     compilation  all teacher-submitted results (read-only)
     collection   unofficial results — Declare Unofficial Result
     finalizing   final review — Declare Official Result
     archive      official results, read-only forever
   Excel + PDF export at every level of every stage.
   ============================================================= */
const META = {
  compilation: { title: "Result Compilation", subtitle: "All results submitted by teachers — Department › Program › Semester › Subject", icon: "Layers" },
  collection: { title: "Results Collection", subtitle: "Unofficial results awaiting declaration. Declaring makes GPA, CGPA and the unofficial transcript visible to students.", icon: "ClipboardList", action: "Declare Unofficial Result" },
  finalizing: { title: "Result Finalizing & Declare Official Result", subtitle: "Final review. Declaring makes results official and permanently immutable.", icon: "BadgeCheck", action: "Declare Official Result" },
  archive: { title: "Results Archive", subtitle: "Officially declared results — read-only, locked for every role.", icon: "Archive" },
};
const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));

function Crumb({ path, onGo }) {
  const parts = [{ label: "All Departments", icon: Home, depth: 0 }];
  if (path.dept) parts.push({ label: path.dept.name, icon: Building2, depth: 1 });
  if (path.prog) parts.push({ label: path.prog.code, icon: GraduationCap, depth: 2 });
  if (path.sem) parts.push({ label: `Semester ${path.sem.number ?? "—"}`, icon: Layers, depth: 3 });
  if (path.subject) parts.push({ label: path.subject.courseCode, icon: BookOpen, depth: 4 });
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm mb-4">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={14} className="text-slate-400" />}
          <button onClick={() => onGo(p.depth)} disabled={i === parts.length - 1} className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg ${i === parts.length - 1 ? "font-bold text-app" : "text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-500/10"}`}>
            <p.icon size={13} /> {p.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

function Tile({ title, subtitle, count, onClick, icon: Icon }) {
  return (
    <button onClick={onClick} className="card-base p-4 text-left hover:border-primary-300 hover:shadow-md transition group">
      <div className="flex items-start justify-between gap-2">
        <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 text-primary-600 flex items-center justify-center"><Icon size={18} /></div>
        <ChevronRight size={16} className="text-slate-300 group-hover:text-primary-500 transition" />
      </div>
      <p className="font-bold text-app mt-3">{title}</p>
      {subtitle && <p className="text-xs text-muted-app mt-0.5">{subtitle}</p>}
      <p className="text-xs font-semibold text-primary-700 dark:text-primary-300 mt-2">{count}</p>
    </button>
  );
}

function ExportButtons({ stage, scope, name }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(null);
  const run = async (format) => {
    setBusy(format);
    try { await api.workflow.exportStage(stage, format, scope, name); }
    catch (e) { toast(e.message, { type: "error" }); }
    finally { setBusy(null); }
  };
  return (
    <div className="flex gap-2">
      <button onClick={() => run("excel")} disabled={!!busy} className="btn-secondary text-xs py-1.5">{busy === "excel" ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} className="text-emerald-600" />} Excel</button>
      <button onClick={() => run("pdf")} disabled={!!busy} className="btn-secondary text-xs py-1.5">{busy === "pdf" ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} className="text-rose-600" />} PDF</button>
    </div>
  );
}

function SubjectSheet({ stage, offeringId }) {
  const { data, loading, error, reload } = useApi(() => api.workflow.subject(stage, offeringId), [stage, offeringId]);
  if (loading) return <Skeleton className="h-64 w-full rounded-2xl" />;
  if (error) return <ErrorState description={error} onRetry={reload} />;
  const s = data.subject;
  return (
    <div className="card-base overflow-hidden">
      <div className="px-4 py-3 bg-gradient-to-r from-primary-50 to-blue-50 dark:from-slate-800 dark:to-slate-800 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-bold text-app">{s.courseCode} — {s.courseTitle}</p>
          <p className="text-xs text-muted-app">{s.department} · {s.program} · Semester {s.semester} · {s.creditHours} Cr · Teacher: {s.teacher || "—"} · Mid total {s.midTotalMarks ?? "—"} · Final total {s.finalTotalMarks ?? "—"}</p>
        </div>
        <ExportButtons stage={stage} scope={{ offeringId }} name={`${stage}-${s.courseCode}`} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 text-[11px] uppercase text-slate-500">
            <tr>
              {["#", "Roll No", "Student", "Batch", "Mid (Obt/Total)", "Final (Obt/Total)", "Total %", "Grade", "GP", "Sem GPA", "CGPA", "Stage"].map((h) => <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.students.map((r, i) => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2 text-muted-app">{i + 1}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.rollNumber}</td>
                <td className="px-3 py-2 font-semibold text-app">{r.student}</td>
                <td className="px-3 py-2 text-xs">{r.batch || "—"}</td>
                <td className="px-3 py-2">{fmt(r.midMarks, 1)} / {fmt(r.midMax, 0)}</td>
                <td className="px-3 py-2">{fmt(r.finalMarks, 1)} / {fmt(r.finalMax, 0)}</td>
                <td className="px-3 py-2 font-semibold">{fmt(r.totalPercent)}</td>
                <td className="px-3 py-2 font-bold text-primary-700 dark:text-primary-300">{r.letterGrade}</td>
                <td className="px-3 py-2">{fmt(r.gradePoints)}</td>
                <td className="px-3 py-2">{fmt(r.semesterGpa)}</td>
                <td className="px-3 py-2">{fmt(r.cgpa)}</td>
                <td className="px-3 py-2"><span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800">{r.workflowStage}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[11px] text-muted-app flex items-center gap-1 border-t border-slate-100 dark:border-slate-800"><Lock size={11} /> Marks are read-only for the Exam Controller.</p>
    </div>
  );
}

function SemesterStudents({ stage, scope }) {
  const { data, loading, error } = useApi(() => api.workflow.students(stage, scope), [stage, scope.department, scope.program, scope.semester]);
  if (loading) return <Skeleton className="h-40 w-full rounded-2xl" />;
  if (error) return <ErrorState description={error} />;
  if (!data.students.length) return null;
  return (
    <div className="card-base overflow-x-auto mt-4">
      <p className="px-4 py-2 text-xs font-bold uppercase text-muted-app">Student-wise semester summary</p>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-900 text-[11px] uppercase text-slate-500">
          <tr><th className="px-3 py-2 text-left">Roll No</th><th className="px-3 py-2 text-left">Student</th><th className="px-3 py-2 text-left">Subjects (Grade / GP)</th><th className="px-3 py-2">GPA</th><th className="px-3 py-2">CGPA</th></tr>
        </thead>
        <tbody>
          {data.students.map((s) => (
            <tr key={s.studentId} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-3 py-2 font-mono text-xs">{s.rollNumber}</td>
              <td className="px-3 py-2 font-semibold text-app">{s.student}</td>
              <td className="px-3 py-2 text-xs">{s.subjects.map((x) => `${x.courseCode}: ${x.letterGrade} (${fmt(x.gradePoints)})`).join(" · ")}</td>
              <td className="px-3 py-2 text-center font-bold">{fmt(s.gpa)}</td>
              <td className="px-3 py-2 text-center font-bold text-primary-700 dark:text-primary-300">{fmt(s.cgpa)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ResultWorkflow({ stage }) {
  const meta = META[stage];
  const { toast } = useToast();
  const { data, loading, error, reload } = useApi(() => api.workflow.tree(stage), [stage]);
  const [path, setPath] = useState({});
  const [declaring, setDeclaring] = useState(false);

  // Re-resolve the selected nodes against fresh tree data (after declarations).
  const tree = useMemo(() => data?.tree || [], [data]);
  const dept = path.dept && tree.find((d) => d.name === path.dept.name);
  const prog = dept && path.prog && dept.programs.find((p) => p.code === path.prog.code);
  const sem = prog && path.sem && prog.semesters.find((s) => s.number === path.sem.number);
  const subject = path.subject;

  const go = (depth) => setPath((p) => ({
    dept: depth >= 1 ? p.dept : undefined,
    prog: depth >= 2 ? p.prog : undefined,
    sem: depth >= 3 ? p.sem : undefined,
    subject: depth >= 4 ? p.subject : undefined,
  }));

  const scope = { department: dept?.name, program: prog?.code, semester: sem?.number };

  const declare = async () => {
    const label = `${dept.name} › ${prog.code} › Semester ${sem.number}`;
    const msg = stage === "collection"
      ? `Declare the UNOFFICIAL result for ${label}?\n\nStudents will immediately see their semester GPA, running CGPA and unofficial transcript. The semester then moves to Result Finalizing.`
      : `Declare the OFFICIAL result for ${label}?\n\nThis is FINAL. Results become official and permanently immutable for every role, and move to the Results Archive.`;
    if (!window.confirm(msg)) return;
    setDeclaring(true);
    try {
      const r = stage === "collection" ? await api.workflow.declareUnofficial(scope) : await api.workflow.declareOfficial(scope);
      toast(r.message, { type: "success" });
      setPath({});
      await reload();
    } catch (e) { toast(e.message, { type: "error" }); }
    finally { setDeclaring(false); }
  };

  return (
    <div>
      <PageHeader title={meta.title} subtitle={meta.subtitle} icon={meta.icon} breadcrumb={["Exam Controller", meta.title]}
        actions={<button onClick={reload} className="btn-secondary text-sm"><RefreshCw size={14} /> Refresh</button>} />

      {loading ? <Skeleton className="h-64 w-full rounded-2xl" /> : error ? <ErrorState description={error} onRetry={reload} /> : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <Crumb path={{ dept, prog, sem, subject }} onGo={go} />
            {!subject && <ExportButtons stage={stage} scope={scope} name={`${stage}-${[dept?.name, prog?.code, sem ? `sem${sem.number}` : null].filter(Boolean).join("-") || "all"}`} />}
          </div>

          {!tree.length ? (
            <EmptyState icon={meta.icon} title="Nothing here yet" description={stage === "compilation" ? "Results appear here as soon as teachers make their final submission." : stage === "collection" ? "No submitted results are waiting for unofficial declaration." : stage === "finalizing" ? "No unofficial results are waiting for official declaration." : "No officially declared results yet."} />
          ) : subject ? (
            <SubjectSheet stage={stage} offeringId={subject.offeringId} />
          ) : sem ? (
            <>
              {meta.action && (
                <div className={`card-base p-4 mb-4 flex flex-wrap items-center gap-3 ${stage === "finalizing" ? "border-rose-200 dark:border-rose-900" : "border-primary-200 dark:border-primary-900"}`}>
                  <div className="flex-1 min-w-[240px]">
                    <p className="font-bold text-app flex items-center gap-2">{stage === "finalizing" ? <ShieldCheck size={16} className="text-rose-600" /> : <Megaphone size={16} className="text-primary-600" />} {meta.action}</p>
                    <p className="text-xs text-muted-app">{sem.results} result(s) across {sem.subjects.length} subject(s) in {dept.name} › {prog.code} › Semester {sem.number}.</p>
                  </div>
                  <button onClick={declare} disabled={declaring} className={`btn-primary text-sm ${stage === "finalizing" ? "bg-rose-600 hover:bg-rose-700" : ""}`}>{declaring && <Loader2 size={14} className="animate-spin" />} {meta.action}</button>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {sem.subjects.map((s) => (
                  <Tile key={s.offeringId} icon={BookOpen} title={`${s.courseCode} — ${s.courseTitle}`} subtitle={`${s.creditHours} Cr · ${s.teacher || "—"}`} count={`${s.students} student(s)`} onClick={() => setPath((p) => ({ ...p, subject: s }))} />
                ))}
              </div>
              <SemesterStudents stage={stage} scope={scope} />
            </>
          ) : prog ? (
            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-3">
              {prog.semesters.map((s) => <Tile key={s.number} icon={Layers} title={`Semester ${s.number ?? "—"}`} subtitle={`${s.subjects.length} subject(s)`} count={`${s.results} result(s)`} onClick={() => setPath((p) => ({ ...p, sem: s }))} />)}
            </div>
          ) : dept ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {dept.programs.map((p) => <Tile key={p.code} icon={GraduationCap} title={p.code} subtitle={p.name} count={`${p.results} result(s)`} onClick={() => setPath((x) => ({ ...x, prog: p }))} />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {tree.map((d) => <Tile key={d.name} icon={Building2} title={d.name} subtitle={`${d.programs.length} program(s)`} count={`${d.results} result(s)`} onClick={() => setPath({ dept: d })} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
