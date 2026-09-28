import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Send, Lock, CheckCircle2, CircleDot, ChevronRight, Award } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import StatCard from "../../components/common/StatCard";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import MarksPinGate, { PinConfirmModal } from "../../components/marks/MarksPinGate";
import GradebookPanel from "../../components/marks/GradebookPanel";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useToast } from "../../context/ToastContext";

/* =============================================================
   Teacher — Results Submission (A7 / A8)
   1. Lists every subject the teacher teaches this term.
   2. Open one subject → review → Publish (confirmation + PIN) → the
      subject result is locked for the teacher.
   3. When every subject is published, Final Submission (confirmation
      + PIN) sends all results to the Exam Controller — permanently
      immutable for every role.
   ============================================================= */
const STATUS = {
  OPEN: { label: "Open — editable", cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300", icon: CircleDot },
  PUBLISHED: { label: "Published — locked", cls: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300", icon: Lock },
  SUBMITTED: { label: "Submitted to Exam Controller", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300", icon: CheckCircle2 },
};

function Body() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.marks.submission(), []);
  const [openId, setOpenId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind:'publish'|'final', subject }

  if (loading) return <Skeleton className="h-64 w-full rounded-2xl" />;
  if (error) return <ErrorState description={error} onRetry={reload} />;
  const subjects = data?.subjects || [];
  const sum = data?.summary || {};
  if (!subjects.length) return <EmptyState icon="BookOpen" title="No subjects this term" description="Subjects assigned to you for the current term will appear here." />;

  const current = subjects.find((s) => s.id === openId) || null;

  // Group by Program › Semester for clear organisation.
  const groups = {};
  subjects.forEach((s) => { (groups[`${s.program || "—"} · Semester ${s.semester || "—"}`] ||= []).push(s); });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard title="Subjects" value={sum.subjects} icon="BookOpen" color="blue" />
        <StatCard title="Published" value={`${sum.published}/${sum.subjects}`} icon="Lock" color="purple" />
        <StatCard title="Students complete" value={`${sum.studentsComplete}/${sum.students}`} icon="Users" color="amber" />
        <StatCard title="Submitted" value={`${sum.submitted}/${sum.subjects}`} icon="ShieldCheck" color="emerald" />
      </div>

      {/* A8 — Final submission status */}
      <div className={`card-base p-4 flex flex-wrap items-center gap-3 ${sum.finalSubmitted ? "border-emerald-300" : ""}`}>
        <div className="flex-1 min-w-[220px]">
          <p className="font-bold text-app flex items-center gap-2"><Send size={16} className="text-primary-600" /> Final Submission to Exam Controller</p>
          <p className="text-xs text-muted-app mt-0.5">
            {sum.finalSubmitted
              ? "All your results were submitted. They are permanently locked — no role can edit them."
              : sum.readyForFinalSubmission
                ? "Every subject is published. Verify the completion status below, then submit all results at once."
                : "Publish every subject first. Final submission sends all subjects to the Exam Controller simultaneously and locks them permanently."}
          </p>
        </div>
        <button disabled={!sum.readyForFinalSubmission} onClick={() => setConfirm({ kind: "final" })} className="btn-primary text-sm disabled:opacity-50">
          <Send size={14} /> Submit all results
        </button>
      </div>

      {/* Subject list */}
      {Object.entries(groups).map(([g, list]) => (
        <div key={g}>
          <p className="text-xs font-bold uppercase tracking-wide text-muted-app mb-2">{g}</p>
          <div className="card-base divide-y divide-slate-100 dark:divide-slate-800">
            {list.map((s) => {
              const st = STATUS[s.status];
              const pct = s.completion.percentComplete;
              return (
                <div key={s.id} className={`p-4 flex flex-wrap items-center gap-3 ${openId === s.id ? "bg-primary-50/50 dark:bg-primary-500/5" : ""}`}>
                  <div className="flex-1 min-w-[220px]">
                    <p className="font-semibold text-app"><span className="font-mono text-primary-700 dark:text-primary-300">{s.courseCode}</span> — {s.courseTitle}</p>
                    <p className="text-xs text-muted-app">{s.creditHours} Cr · {s.completion.students} students · {s.completion.studentsComplete} complete · Mid total {s.midTotalMarks ?? "—"} · Final total {s.finalTotalMarks ?? "—"}</p>
                    <div className="mt-1.5 h-1.5 w-48 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden"><div className="h-full bg-primary-500" style={{ width: `${pct}%` }} /></div>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-semibold inline-flex items-center gap-1 ${st.cls}`}><st.icon size={12} /> {st.label}</span>
                  <button onClick={() => setOpenId(openId === s.id ? null : s.id)} className="btn-secondary text-sm">{openId === s.id ? "Close" : "Review"} <ChevronRight size={14} className={openId === s.id ? "rotate-90 transition" : "transition"} /></button>
                  {s.status === "OPEN" && (
                    <button onClick={() => setConfirm({ kind: "publish", subject: s })} className="btn-primary text-sm"><Award size={14} /> Publish result</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {current && (
        <div className="card-base p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="font-bold text-app">Reviewing {current.courseCode} — {current.courseTitle}</p>
            <button onClick={() => navigate(`/teacher/offerings/${current.id}?tab=marks&scope=marks`)} className="text-xs text-primary-600 hover:underline">Open full gradebook</button>
          </div>
          <GradebookPanel key={current.id} offeringId={current.id} />
        </div>
      )}

      <PinConfirmModal
        open={!!confirm}
        openKey={confirm ? `${confirm.kind}-${confirm.subject?.id || "all"}` : undefined}
        danger={confirm?.kind === "final"}
        title={confirm?.kind === "final" ? "Submit all results to the Exam Controller?" : `Publish ${confirm?.subject?.courseCode} result?`}
        message={confirm?.kind === "final"
          ? `This sends all ${sum.subjects} subject result(s) to the Exam Controller and locks them PERMANENTLY. No one — including you, the Exam Controller or Super Admin — can edit them afterwards.`
          : "Once published, you can no longer edit any marks for this subject. Make sure every mark is correct."}
        confirmLabel={confirm?.kind === "final" ? "Submit permanently" : "Publish & lock"}
        onClose={() => setConfirm(null)}
        onConfirm={async (pin) => {
          const r = confirm.kind === "final" ? await api.marks.finalSubmit(pin) : await api.marks.publishSubject(confirm.subject.id, pin);
          toast(r.message, { type: "success" });
          await reload();
        }}
      />
    </div>
  );
}

export default function ResultsSubmission() {
  return (
    <div>
      <PageHeader title="Results Submission" subtitle="Review, publish and submit your subject results to the Exam Controller" icon="Send" breadcrumb={["Teacher", "Results Submission"]} />
      <MarksPinGate title="Results Submission">
        <Body />
      </MarksPinGate>
    </div>
  );
}
