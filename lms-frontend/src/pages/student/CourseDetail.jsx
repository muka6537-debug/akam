import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, FileText, Megaphone, CalendarCheck, Download, BookOpen, FlaskConical, ChevronRight } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import Badge from "../../components/common/Badge";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import useApi from "../../hooks/useApi";
import api, { fileUrl } from "../../services/api";

const teacherName = (o) => o?.teacher?.profile?.fullName || o?.teacher?.username || "TBA";
// Real instructor photo (live from the teacher's profile). Falls back to a
// generated initials avatar when no photo has been uploaded.
const teacherPhoto = (o) => {
  const url = o?.teacher?.profile?.photoUrl;
  return url ? fileUrl(url) : null;
};
const avatarFor = (name) =>
  `https://ui-avatars.com/api/?name=${encodeURIComponent(name || "Instructor")}&background=2563eb&color=fff`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

const CourseDetail = () => {
  const { offeringId } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.student.course(offeringId), [offeringId]);

  const offering = data?.offering;
  const course = offering?.course;
  const att = data?.attendance;
  const materials = data?.materials || [];
  const announcements = data?.announcements || [];
  // B1.d — Theory and Lab are two separate sections of ONE course.
  const hasLab = !!course?.hasLab;
  const [section, setSection] = useState("theory");
  const labApi = useApi(() => (hasLab ? api.student.labTasks() : Promise.resolve({ courses: [] })), [hasLab, offeringId]);
  const gb = useApi(() => api.student.courseGradebook(offeringId), [offeringId]);
  const labCourse = (labApi.data?.courses || []).find((c) => String(c.offeringId) === String(offeringId));
  const labTasks = labCourse?.labTasks || [];
  const cats = gb.data?.breakdown?.categories || [];
  const theoryCats = cats.filter((c) => c.key !== "lab");
  const labCat = cats.find((c) => c.key === "lab");

  return (
    <div>
      <button
        onClick={() => navigate("/student/courses")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-app hover:text-primary-600 mb-3"
      >
        <ArrowLeft size={15} /> Back to Courses
      </button>

      <PageHeader
        title={loading ? "Loading…" : course?.title || "Course"}
        subtitle={course ? `${course.code} · ${teacherName(offering)}` : ""}
        icon="BookOpen"
        breadcrumb={["Courses", course?.code || ""]}
      />

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : error ? (
        <ErrorState description={error} onRetry={reload} />
      ) : (
        <div className="space-y-6">
          {/* Course Instructor — real name + live profile photo */}
          {offering?.teacher && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5 flex items-center gap-4">
              <img
                src={teacherPhoto(offering) || avatarFor(teacherName(offering))}
                onError={(e) => { e.currentTarget.src = avatarFor(teacherName(offering)); }}
                alt={teacherName(offering)}
                className="w-14 h-14 rounded-2xl object-cover border border-slate-200 dark:border-slate-700"
              />
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide font-semibold text-slate-400">Course Instructor</p>
                <p className="font-bold text-app leading-tight truncate">{teacherName(offering)}</p>
                {offering.teacher.profile?.designation && (
                  <p className="text-xs text-muted-app truncate">{offering.teacher.profile.designation}</p>
                )}
              </div>
            </div>
          )}

          {hasLab && (
            <div className="flex gap-2 p-1 rounded-2xl bg-slate-100 dark:bg-slate-800 w-fit" role="tablist">
              {[["theory", "Theory", BookOpen, `${course.theoryCredit ?? course.creditHours - (course.labCredit || 0)} Cr`], ["lab", "Lab", FlaskConical, `${course.labCredit ?? 1} Cr`]].map(([k, l, Icon, cr]) => (
                <button key={k} role="tab" aria-selected={section === k} onClick={() => setSection(k)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-1.5 ${section === k ? (k === "lab" ? "bg-indigo-600 text-white shadow" : "bg-primary-600 text-white shadow") : "text-slate-600 dark:text-slate-300"}`}>
                  <Icon size={15} /> {l} <span className="text-[10px] opacity-80">{cr}</span>
                </button>
              ))}
            </div>
          )}

          {hasLab && section === "lab" ? (
            <div className="space-y-6">
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-indigo-100 dark:border-indigo-900 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-app flex items-center gap-2"><FlaskConical size={18} className="text-indigo-600" /> Lab Tasks</h3>
                  <button onClick={() => navigate("/student/lab-tasks")} className="text-xs font-semibold text-indigo-600 hover:underline inline-flex items-center gap-0.5">Submit lab work <ChevronRight size={13} /></button>
                </div>
                {labApi.loading ? <Skeleton className="h-20 w-full rounded-xl" /> : labTasks.length === 0 ? (
                  <EmptyState icon="FlaskConical" title="No lab tasks yet" description="Lab tasks posted by your instructor will appear here." className="py-6" />
                ) : (
                  <div className="space-y-2">
                    {labTasks.map((t) => (
                      <div key={t.id} className="flex items-center justify-between p-3 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20">
                        <div className="min-w-0">
                          <p className="font-semibold text-sm text-app truncate">{t.title}</p>
                          <p className="text-xs text-muted-app">Due {fmtDate(t.dueDate)} · {t.totalMarks} marks</p>
                        </div>
                        <span className="text-xs font-bold">{t.submission?.marks != null ? `${t.submission.marks} / ${t.totalMarks}` : t.submission ? "Submitted" : "Not submitted"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {labCat && (
                <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5">
                  <h3 className="font-bold text-app mb-2 flex items-center gap-2"><CalendarCheck size={18} /> Lab Weightage</h3>
                  <p className="text-sm text-muted-app">Lab counts for <b className="text-app">{labCat.weight}%</b> of this course · earned so far <b className="text-indigo-700 dark:text-indigo-300">{Number(labCat.obtained || 0).toFixed(2)}</b></p>
                </div>
              )}
            </div>
          ) : (
          <div className="space-y-6">
          {/* Attendance summary */}
          {att && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { label: "Attendance", value: `${att.percentage}%`, color: "blue" },
                { label: "Present", value: att.present, color: "emerald" },
                { label: "Absent", value: att.absent, color: "rose" },
                { label: "Late", value: att.late, color: "amber" },
                { label: "Sessions", value: att.totalSessions, color: "slate" },
              ].map((s) => (
                <div key={s.label} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-4 text-center">
                  <p className="text-2xl font-extrabold text-app">{s.value}</p>
                  <p className="text-xs text-muted-app mt-1">{s.label}</p>
                </div>
              ))}
            </div>
          )}

          {/* Grade weights */}
          {offering && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5">
              <h3 className="font-bold text-app mb-3 flex items-center gap-2"><CalendarCheck size={18} /> Assessment Weights</h3>
              <div className="flex flex-wrap gap-2">
                {theoryCats.length ? theoryCats.map((c, i) => (
                  <Badge key={c.key} color={["blue", "purple", "amber", "rose", "emerald", "slate"][i % 6]}>{c.label} {c.weight}%</Badge>
                )) : (
                  <>
                    <Badge color="blue">Assignments {offering.assignmentWeight}%</Badge>
                    <Badge color="purple">Quizzes {offering.quizWeight}%</Badge>
                    <Badge color="amber">Midterm {offering.midWeight}%</Badge>
                    <Badge color="rose">Final {offering.finalWeight}%</Badge>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Materials */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5">
            <h3 className="font-bold text-app mb-3 flex items-center gap-2"><FileText size={18} /> Course Materials</h3>
            {materials.length === 0 ? (
              <EmptyState icon="FileText" title="No materials" description="The instructor hasn't uploaded any materials yet." className="py-8" />
            ) : (
              <div className="space-y-2">
                {materials.map((m) => (
                  <div key={m.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40">
                    <div>
                      <p className="font-semibold text-sm text-app">{m.title}</p>
                      <p className="text-xs text-muted-app">{fmtDate(m.createdAt)}</p>
                    </div>
                    {m.fileUrl && (
                      <a href={fileUrl(m.fileUrl)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-primary-600 text-sm font-semibold hover:underline">
                        <Download size={14} /> Download
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Announcements */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5">
            <h3 className="font-bold text-app mb-3 flex items-center gap-2"><Megaphone size={18} /> Announcements</h3>
            {announcements.length === 0 ? (
              <EmptyState icon="Megaphone" title="No announcements" description="No announcements posted for this course." className="py-8" />
            ) : (
              <div className="space-y-3">
                {announcements.map((a) => (
                  <motion.div key={a.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 rounded-xl border border-slate-100 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-app">{a.title}</p>
                      <span className="text-xs text-muted-app">{fmtDate(a.createdAt)}</span>
                    </div>
                    <p className="text-sm text-muted-app mt-1 whitespace-pre-wrap">{a.body || a.content}</p>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
          </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CourseDetail;
