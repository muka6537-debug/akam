import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Video, Radio, Clock, Calendar, ExternalLink, Play, User, X, Maximize2,
  Mic, MicOff, Camera, MessageSquare, Users, Hand, MonitorUp, PenTool,
  Presentation, Smile, BarChart3, Loader2, AlertTriangle,
} from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { fileUrl } from "../../services/api";
import { useToast } from "../../context/ToastContext";

// The full set of BigBlueButton classroom features surfaced in the join panel.
const BBB_FEATURES = [
  { icon: Mic, label: "Audio Join" },
  { icon: MicOff, label: "Listen Only" },
  { icon: Camera, label: "Webcam" },
  { icon: MessageSquare, label: "Public & Private Chat" },
  { icon: Users, label: "Participants Panel" },
  { icon: Hand, label: "Raise Hand" },
  { icon: PenTool, label: "Multi-user Whiteboard" },
  { icon: Presentation, label: "Presentation Viewer" },
  { icon: MonitorUp, label: "Screen Sharing" },
  { icon: BarChart3, label: "Polls" },
  { icon: Smile, label: "Reactions & Emojis" },
  { icon: Video, label: "Breakout Rooms" },
];

const statusMeta = (s) => {
  const v = (s || "").toUpperCase();
  if (v === "LIVE") return { chip: "bg-rose-100 text-rose-700 animate-pulse", label: "Live Now", dot: "bg-rose-500" };
  if (v === "SCHEDULED" || v === "UPCOMING") return { chip: "bg-blue-100 text-blue-700", label: "Scheduled", dot: "bg-blue-500" };
  if (v === "ENDED" || v === "COMPLETED") return { chip: "bg-slate-100 text-slate-600", label: "Ended", dot: "bg-slate-400" };
  return { chip: "bg-slate-100 text-slate-600", label: s || "—", dot: "bg-slate-400" };
};


// Distinct, colour-blind-friendly accents per course (B1.c).
const COURSE_PALETTE = [
  { bar: "bg-blue-500", soft: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300", chip: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200" },
  { bar: "bg-emerald-500", soft: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300", chip: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200" },
  { bar: "bg-amber-500", soft: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300", chip: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" },
  { bar: "bg-violet-500", soft: "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300", chip: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200" },
  { bar: "bg-rose-500", soft: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300", chip: "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200" },
  { bar: "bg-cyan-500", soft: "bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300", chip: "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-200" },
  { bar: "bg-orange-500", soft: "bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300", chip: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200" },
  { bar: "bg-teal-500", soft: "bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300", chip: "bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200" },
];

const resolveRecording = (lc) => {
  if (!lc.recordingUrl) return null;
  return /^https?:\/\//i.test(lc.recordingUrl) ? lc.recordingUrl : fileUrl(lc.recordingUrl);
};

const LiveClasses = () => {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, loading, error, reload } = useApi(() => api.student.liveClasses(), []);
  const [filter, setFilter] = useState("ALL");
  const [joining, setJoining] = useState(null); // id currently being joined
  const [room, setRoom] = useState(null); // active BBB classroom session
  const [autoJoined, setAutoJoined] = useState(false);

  // Open the in-app BigBlueButton classroom for a scheduled/live class.
  const joinClass = async (lc) => {
    setJoining(lc.id);
    try {
      const res = await api.student.joinLiveClass(lc.id);
      setRoom(res.join);
    } catch (e) {
      toast(e.message || "Unable to join the live class", { type: "error" });
    } finally {
      setJoining(null);
    }
  };

  // Leave the classroom — records leave time + duration for attendance.
  const leaveClass = async () => {
    const r = room;
    setRoom(null);
    if (r && r.id) {
      try { await api.student.leaveLiveClass(r.id, r.attendanceId); } catch { /* non-blocking */ }
    }
  };

  // Ensure leave is posted if the tab/window is closed while in a class.
  useEffect(() => {
    if (!room) return;
    const handler = () => {
      try {
        const url = `${api.base}/lms/academic/student/live-classes/${room.id}/leave`;
        const blob = new Blob([JSON.stringify({ attendanceId: room.attendanceId })], { type: "application/json" });
        if (navigator.sendBeacon) navigator.sendBeacon(url, blob);
      } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [room]);

  const classes = useMemo(() => {
    const all = data?.liveClasses || [];
    return [...all].sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
  }, [data]);

  // Auto-open the classroom when deep-linked from a course card (?join=<id>).
  useEffect(() => {
    if (autoJoined || room) return;
    const joinId = searchParams.get("join");
    if (!joinId || classes.length === 0) return;
    const target = classes.find((c) => String(c.id) === String(joinId));
    if (target) {
      setAutoJoined(true);
      joinClass(target);
      const next = new URLSearchParams(searchParams);
      next.delete("join");
      setSearchParams(next, { replace: true });
    }
  }, [classes, searchParams, autoJoined, room]); // eslint-disable-line react-hooks/exhaustive-deps

  // B1.c — each course gets its own stable accent so classes of different
  // courses are never visually confused.
  const courses = useMemo(() => {
    const m = new Map();
    classes.forEach((c) => { if (c.courseCode && !m.has(c.courseCode)) m.set(c.courseCode, { code: c.courseCode, title: c.courseTitle, teacher: c.teacher }); });
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code)).map((c, i) => ({ ...c, color: COURSE_PALETTE[i % COURSE_PALETTE.length] }));
  }, [classes]);
  const colorOf = (code) => (courses.find((c) => c.code === code) || { color: COURSE_PALETTE[0] }).color;
  const [courseFilter, setCourseFilter] = useState("ALL");

  const shown = useMemo(() => {
    let list = classes;
    if (courseFilter !== "ALL") list = list.filter((c) => c.courseCode === courseFilter);
    const st = (c) => (c.status || "").toUpperCase();
    if (filter === "UPCOMING") list = list.filter((c) => ["SCHEDULED", "UPCOMING", "LIVE"].includes(st(c)));
    if (filter === "RECORDED") list = list.filter((c) => ["ENDED", "COMPLETED"].includes(st(c)));
    return list;
  }, [classes, filter, courseFilter]);

  // Split into Live now / Today / Upcoming / Past for an at-a-glance agenda.
  const sections = useMemo(() => {
    const now = new Date();
    const today = now.toDateString();
    const st = (c) => (c.status || "").toUpperCase();
    const live = [], todays = [], upcoming = [], past = [];
    shown.forEach((c) => {
      const d = new Date(c.scheduledAt);
      if (st(c) === "LIVE") live.push(c);
      else if (["ENDED", "COMPLETED", "CANCELLED"].includes(st(c)) || d.getTime() + (c.durationMin || 60) * 60000 < now.getTime()) past.push(c);
      else if (d.toDateString() === today) todays.push(c);
      else upcoming.push(c);
    });
    const asc = (a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt);
    return [
      { key: "live", title: "Live now", items: live.sort(asc) },
      { key: "today", title: "Today", items: todays.sort(asc) },
      { key: "upcoming", title: "Upcoming", items: upcoming.sort(asc) },
      { key: "past", title: "Past sessions", items: past.sort((a, b) => -asc(a, b)) },
    ].filter((sct) => sct.items.length);
  }, [shown]);

  if (loading) {
    return (
      <div>
        <PageHeader title="Live Classes" subtitle="Join live sessions and watch recordings" icon="Radio" breadcrumb={["Dashboard", "Live Classes"]} />
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
      </div>
    );
  }

  const renderCard = (lc) => {
    const sm = statusMeta(lc.status);
    const recording = resolveRecording(lc);
    const isLive = (lc.status || "").toUpperCase() === "LIVE";
    const ended = ["ENDED", "COMPLETED"].includes((lc.status || "").toUpperCase());
    const col = colorOf(lc.courseCode);
    const d = new Date(lc.scheduledAt);
    const end = new Date(d.getTime() + (lc.durationMin || 60) * 60000);
    const hm = (x) => x.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return (
      <motion.div key={lc.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className={`relative bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 overflow-hidden flex ${isLive ? "ring-2 ring-rose-400" : ""}`}>
        <div className={`w-1.5 shrink-0 ${col.bar}`} />
        <div className="flex-1 p-4 flex flex-col md:flex-row md:items-center gap-4 min-w-0">
          <div className={`w-16 shrink-0 rounded-xl text-center py-2 ${col.soft}`}>
            <p className="text-[10px] font-bold uppercase">{d.toLocaleDateString("en-GB", { weekday: "short" })}</p>
            <p className="text-xl font-extrabold leading-tight">{d.getDate()}</p>
            <p className="text-[10px] font-semibold">{d.toLocaleDateString("en-GB", { month: "short" })}</p>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded-md ${col.chip}`}>{lc.courseCode}</span>
              <span className="font-display font-bold text-slate-900 dark:text-slate-100 truncate">{lc.courseTitle}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sm.chip}`}>{sm.label}</span>
              {lc.fromSchedule && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">Weekly schedule</span>}
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 truncate">{lc.title}</p>
            <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 flex-wrap">
              <span className="flex items-center gap-1"><Clock size={11} /> {hm(d)} – {hm(end)} ({lc.durationMin} min)</span>
              {lc.teacher && <span className="flex items-center gap-1"><User size={11} /> {lc.teacher}</span>}
              {lc.description && <span className="flex items-center gap-1 truncate"><Calendar size={11} /> {lc.description}</span>}
            </div>
          </div>
          <div className="shrink-0">
            {isLive && lc.joinUrl ? (
              <button onClick={() => joinClass(lc)} disabled={joining === lc.id} className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-xl bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60">{joining === lc.id ? <Loader2 size={15} className="animate-spin" /> : <Radio size={15} />} Join Live</button>
            ) : ended && recording ? (
              <a href={recording} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-xl bg-primary-600 text-white hover:bg-primary-700"><Play size={15} /> Watch Recording</a>
            ) : !ended && lc.joinUrl ? (
              <button onClick={() => joinClass(lc)} disabled={joining === lc.id} className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60">{joining === lc.id ? <Loader2 size={15} className="animate-spin" /> : <ExternalLink size={15} />} Join Classroom</button>
            ) : !ended ? (
              <span className="text-xs font-semibold text-slate-500 px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 inline-flex items-center gap-1"><Clock size={13} /> Opens when the teacher starts</span>
            ) : (
              <span className="text-xs text-slate-400">No recording</span>
            )}
          </div>
        </div>
      </motion.div>
    );
  };

  return (
    <div>
      <PageHeader title="Live Classes" subtitle="Your live sessions, organised by course — times follow the Weekly Schedule" icon="Radio" breadcrumb={["Dashboard", "Live Classes"]}
        actions={<button onClick={reload} className="btn-secondary text-sm">Refresh</button>} />

      {error ? (
        <ErrorState description={error} onRetry={reload} />
      ) : classes.length === 0 ? (
        <EmptyState icon="Radio" title="No live classes" description="Live classes appear here automatically once your course's weekly schedule is set." />
      ) : (
        <>
          {/* Course legend / filter — each course has its own colour */}
          <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar">
            <button onClick={() => setCourseFilter("ALL")} className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap border ${courseFilter === "ALL" ? "bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900" : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"}`}>All courses</button>
            {courses.map((c) => (
              <button key={c.code} onClick={() => setCourseFilter(c.code)} title={c.title}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap border flex items-center gap-1.5 ${courseFilter === c.code ? `${c.color.chip} border-transparent` : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"}`}>
                <span className={`w-2 h-2 rounded-full ${c.color.bar}`} /> {c.code} · {c.title}
              </button>
            ))}
          </div>
          <div className="flex gap-2 mb-5">
            {[["ALL", "All"], ["UPCOMING", "Upcoming & Live"], ["RECORDED", "Recorded"]].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold ${filter === k ? "bg-primary-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"}`}>{l}</button>
            ))}
          </div>

          {!sections.length ? (
            <EmptyState icon="Radio" title="Nothing here" description="No classes match this filter." />
          ) : sections.map((sct) => (
            <div key={sct.key} className="mb-6">
              <p className={`text-xs font-bold uppercase tracking-wide mb-2 ${sct.key === "live" ? "text-rose-600" : "text-muted-app"}`}>{sct.title} · {sct.items.length}</p>
              <div className="space-y-2.5">{sct.items.map(renderCard)}</div>
            </div>
          ))}
        </>
      )}

      {/* ---- BigBlueButton in-app classroom ---- */}
      <AnimatePresence>
        {room && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex flex-col"
          >
            {/* Top bar */}
            <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800 text-white shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <span className="flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full bg-rose-600/90"><span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> {(room.status || "").toUpperCase() === "LIVE" ? "LIVE" : "CLASSROOM"}</span>
                <div className="min-w-0">
                  <p className="font-display font-bold truncate">{room.title}</p>
                  <p className="text-[11px] text-slate-400 truncate">{room.courseCode} · {room.courseTitle} · {room.teacher} · BigBlueButton</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a href={room.joinUrl} target="_blank" rel="noreferrer" title="Open in new tab" className="p-2 rounded-lg hover:bg-slate-800 text-slate-300"><Maximize2 size={16} /></a>
                <button onClick={leaveClass} title="Leave classroom" className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700"><X size={15} /> Leave</button>
              </div>
            </div>

            {/* Body: embedded BBB classroom + feature rail */}
            <div className="flex-1 flex min-h-0">
              <div className="flex-1 bg-black relative">
                <iframe
                  title="BigBlueButton Classroom"
                  src={room.joinUrl}
                  className="w-full h-full border-0"
                  allow="camera; microphone; fullscreen; display-capture; autoplay; clipboard-write"
                  allowFullScreen
                />
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-2xl bg-slate-900/85 backdrop-blur text-white text-[11px] border border-slate-700">
                  <span className="flex items-center gap-1"><User size={12} /> {room.attendeeName}</span>
                  <span className="text-slate-500">·</span>
                  <span className="flex items-center gap-1"><Clock size={12} /> {room.durationMin} min</span>
                </div>
              </div>

              {/* Feature rail — mirrors the BBB classroom toolset */}
              <aside className="hidden lg:flex w-64 flex-col bg-slate-900 border-l border-slate-800 p-4 text-slate-300 overflow-y-auto shrink-0">
                <p className="text-[11px] uppercase tracking-wide font-bold text-slate-500 mb-3">Classroom Tools</p>
                <div className="grid grid-cols-1 gap-1.5">
                  {BBB_FEATURES.map((f) => (
                    <div key={f.label} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-slate-800/60 text-[12px] font-medium">
                      <f.icon size={14} className="text-primary-400 shrink-0" /> {f.label}
                    </div>
                  ))}
                </div>
                <div className="mt-4 p-3 rounded-xl bg-slate-800/60 text-[11px] text-slate-400 leading-relaxed">
                  <p className="flex items-center gap-1.5 font-semibold text-slate-300 mb-1"><AlertTriangle size={12} className="text-amber-400" /> Tip</p>
                  Allow camera & microphone access when prompted to use audio, webcam and screen sharing inside the BigBlueButton classroom.
                </div>
              </aside>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default LiveClasses;
