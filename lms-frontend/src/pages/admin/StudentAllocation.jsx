import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Users, Search, GraduationCap, BookOpen, UsersRound, Download, RefreshCw } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import StatCard from "../../components/common/StatCard";
import Modal from "../../components/common/Modal";
import { useToast } from "../../context/ToastContext";
import api from "../../services/api";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";

/* =========================================================================
 * Course Coordinator → Student Allocation (LIVE, section-free)
 *
 * LMS Enhancement B1.e removed the "Section" concept entirely. Students are
 * organised by Program → Batch → Semester only. This view groups the current
 * term's enrolled students per program + semester, showing the batches in
 * each group and the courses they are enrolled in. 100% live DB data from
 * /coordinator/semester-allocation (refreshes on SSE "allocation" events).
 * ======================================================================= */

const StudentAllocation = () => {
  const { toast } = useToast();

  const [data, setData] = useState({ groups: [], termLabel: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [programFilter, setProgramFilter] = useState("all");
  const [semesterFilter, setSemesterFilter] = useState("all");
  const [viewing, setViewing] = useState(null);
  const [studentQuery, setStudentQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.coordinator.semesterAllocation();
      setData(res || { groups: [] });
    } catch (err) {
      setError(err.message || "Failed to load allocation");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let es;
    try {
      es = new EventSource(api.coordinator.eventsUrl());
      es.addEventListener("allocation", () => load());
    } catch { /* SSE optional */ }
    return () => { if (es) es.close(); };
  }, [load]);

  const groups = useMemo(() => data.groups || [], [data]);

  const programs = useMemo(
    () => [...new Map(groups.map((g) => [g.programId, g.programShortForm || g.programName])).entries()],
    [groups]
  );
  const semesters = useMemo(
    () => [...new Set(groups.map((g) => g.semesterNumber))].sort((a, b) => a - b),
    [groups]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((g) => {
      if (programFilter !== "all" && String(g.programId) !== programFilter) return false;
      if (semesterFilter !== "all" && String(g.semesterNumber) !== semesterFilter) return false;
      const hay = `${g.programShortForm} ${g.programName} semester ${g.semesterNumber} ${(g.batches || []).map((b) => b.batch).join(" ")}`.toLowerCase();
      if (q && !hay.includes(q)) return false;
      return true;
    });
  }, [groups, query, programFilter, semesterFilter]);

  const stats = useMemo(() => {
    const students = groups.reduce((s, g) => s + g.totalStudents, 0);
    const batches = new Set();
    groups.forEach((g) => (g.batches || []).forEach((b) => batches.add(b.batch)));
    const courses = groups.reduce((s, g) => s + (g.offeringCount || 0), 0);
    return { students, semesters: groups.length, batches: batches.size, courses };
  }, [groups]);

  const exportCsv = () => {
    if (filtered.length === 0) { toast("Nothing to export", { type: "warning" }); return; }
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [];
    filtered.forEach((g) => {
      g.students.forEach((s) => {
        rows.push([g.programShortForm, `Semester ${g.semesterNumber}`, s.batch || "", s.roll, s.name, s.courses].map(esc).join(","));
      });
    });
    const head = "Program,Semester,Batch,Roll,Name,Courses";
    const blob = new Blob([`${head}\n${rows.join("\n")}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "student-allocation.csv"; a.click();
    URL.revokeObjectURL(url);
    toast("Allocation exported", { type: "success" });
  };

  const viewStudents = useMemo(() => {
    if (!viewing) return [];
    const q = studentQuery.trim().toLowerCase();
    return (viewing.students || []).filter((s) => !q || `${s.name} ${s.roll} ${s.batch || ""}`.toLowerCase().includes(q));
  }, [viewing, studentQuery]);

  return (
    <div>
      <PageHeader
        title="Student Allocation"
        subtitle={`Students organised by Program → Batch → Semester${data.termLabel ? ` · ${data.termLabel}` : ""}`}
        icon="UsersRound"
        breadcrumb={["Course Coordinator", "Student Allocation"]}
        actions={
          <div className="flex gap-2">
            <button onClick={load} className="px-3 py-2 rounded-xl border border-app text-sm font-bold text-app inline-flex items-center gap-1.5">
              <RefreshCw size={14} /> Refresh
            </button>
            <button onClick={exportCsv} className="btn-secondary text-sm py-2 px-3"><Download size={14} className="inline mr-1" /> Export CSV</button>
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <StatCard title="Students" value={stats.students} icon="Users" color="purple" delay={0.05} />
        <StatCard title="Program Semesters" value={stats.semesters} icon="GraduationCap" color="blue" delay={0.1} />
        <StatCard title="Batches" value={stats.batches} icon="Layers" color="emerald" delay={0.15} />
        <StatCard title="Course Offerings" value={stats.courses} icon="BookOpen" color="amber" delay={0.2} />
      </div>

      <div className="card-base p-3 mb-5 flex flex-col md:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-app" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by program, semester or batch..." className="input-base w-full pl-10 text-sm" />
        </div>
        <select value={programFilter} onChange={(e) => setProgramFilter(e.target.value)} className="input-base text-sm md:w-48">
          <option value="all">All Programs</option>
          {programs.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select value={semesterFilter} onChange={(e) => setSemesterFilter(e.target.value)} className="input-base text-sm md:w-44">
          <option value="all">All Semesters</option>
          {semesters.map((s) => <option key={s} value={s}>Semester {s}</option>)}
        </select>
      </div>

      {error ? (
        <ErrorState title="Couldn't load allocation" description={error} onRetry={load} />
      ) : loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-52" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState icon="UsersRound" title="No semester groups found" description="No enrolled students for the selected filters this term." />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((g, i) => (
            <motion.div key={g.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} className="card-base p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white shadow-md">
                  <GraduationCap size={20} />
                </div>
                <span className="px-2 py-0.5 bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 text-xs font-bold rounded">
                  Semester {g.semesterNumber}
                </span>
              </div>
              <p className="font-bold text-app leading-tight">{g.programShortForm || g.programName}</p>
              <p className="text-xs text-muted-app mb-3 truncate">{g.programName}</p>

              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="surface rounded-lg border border-app p-2 text-center">
                  <p className="text-lg font-bold text-app">{g.totalStudents}</p>
                  <p className="text-[10px] uppercase font-bold text-muted-app">Students</p>
                </div>
                <div className="surface rounded-lg border border-app p-2 text-center">
                  <p className="text-lg font-bold text-app">{g.offeringCount}</p>
                  <p className="text-[10px] uppercase font-bold text-muted-app">Courses</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 mb-3 min-h-[1.5rem]">
                {(g.batches || []).map((b) => (
                  <span key={b.batch} className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-slate-100 dark:bg-slate-800 text-app border border-app">
                    Batch {b.batch} · {b.count}
                  </span>
                ))}
              </div>

              <div className="flex items-center justify-end pt-3 border-t border-app">
                <button onClick={() => { setViewing(g); setStudentQuery(""); }} className="px-2.5 py-1.5 bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-500/20 inline-flex items-center gap-1 text-xs font-bold border border-blue-200 dark:border-blue-500/30">
                  <Users size={12} /> View students
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `${viewing.programShortForm} · Semester ${viewing.semesterNumber}` : ""}
        subtitle={viewing ? `${viewing.totalStudents} student(s) · ${viewing.offeringCount} course(s)` : ""}
        icon={UsersRound}
        maxWidth="max-w-lg"
      >
        {viewing && (
          <div className="space-y-3">
            <div className="surface rounded-xl border border-app overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 text-xs font-bold uppercase text-muted-app flex items-center gap-1.5">
                <BookOpen size={12} /> Courses
              </div>
              <div className="max-h-36 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                {(viewing.courses || []).map((c) => (
                  <div key={c.offeringId} className="px-3 py-1.5 flex items-center justify-between text-xs">
                    <span className="text-app"><span className="font-bold">{c.code}</span> — {c.title}</span>
                    <span className="text-muted-app">{c.enrolled} enrolled</span>
                  </div>
                ))}
              </div>
            </div>

            <input value={studentQuery} onChange={(e) => setStudentQuery(e.target.value)} placeholder="Search student, roll or batch..." className="input-base w-full text-sm" />

            <div className="surface rounded-xl border border-app overflow-hidden">
              <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                {viewStudents.length === 0 ? (
                  <p className="px-3 py-4 text-xs text-muted-app italic text-center">No students.</p>
                ) : (
                  viewStudents.map((s) => (
                    <div key={s.id} className="px-3 py-2 flex items-center justify-between text-sm">
                      <div className="min-w-0">
                        <p className="font-semibold text-app truncate">{s.name}</p>
                        <p className="text-[11px] text-muted-app">{s.roll}</p>
                      </div>
                      <span className="px-2 py-0.5 rounded-lg text-xs font-bold bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300 border border-primary-200 dark:border-primary-500/30">
                        {s.batch ? `Batch ${s.batch}` : "—"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default StudentAllocation;
