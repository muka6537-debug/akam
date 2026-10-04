import { useCallback, useState } from "react";
import { BadgePercent, Plus, History, Pencil, XCircle, ShieldCheck } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import Modal from "../../components/common/Modal";
import ErrorState from "../../components/common/ErrorState";
import { Skeleton } from "../../components/common/Skeleton";
import useApi from "../../hooks/useApi";
import api, { fileUrl } from "../../services/api";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { fmtDate } from "../../utils/feeFormat";
import { FeeStatus, FeeFilters, ExportButtons, Field, ChipSelect, Table } from "../../components/fees/feeUi";

const LISTS = [
  { key: "", label: "All" },
  { key: "waived", label: "Waived" },
  { key: "reduced", label: "Reduced" },
  { key: "scholarship", label: "Scholarship Holders" },
  { key: "expiring", label: "Expiring Soon" },
  { key: "review", label: "Needs Review" },
  { key: "revoked", label: "Revoked" },
];

const BLANK = { typeId: "", mode: "PERCENT", value: "", headIds: [], startSemester: "", durationType: "SEMESTERS", semesters: "1", minCgpa: "", reason: "", proof: null };

const ApplyForm = ({ student, config, onDone, onCancel }) => {
  const { toast } = useToast();
  const [f, setF] = useState({ ...BLANK, startSemester: String(student.semester || 1) });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const type = config.concessionTypes.find((t) => String(t.id) === f.typeId);
  const waiver = type?.category === "WAIVER";
  const heads = config.heads.filter((h) => h.isActive && h.category !== "CHARGE");

  const submit = async () => {
    if (!f.reason.trim()) return toast("A reason is required", { type: "error" });
    if (!f.proof) return toast("Upload a proof document", { type: "error" });
    const fd = new FormData();
    fd.append("studentId", student.studentId);
    for (const k of ["typeId", "mode", "value", "startSemester", "durationType", "semesters", "minCgpa", "reason"]) fd.append(k, f[k]);
    fd.append("headIds", JSON.stringify(f.headIds));
    fd.append("proof", f.proof);
    setSaving(true);
    try {
      await api.fees.applyConcession(fd);
      toast("Concession applied — student notified", { type: "success" });
      onDone();
    } catch (e) {
      toast(e.message, { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-3 rounded-xl bg-app-subtle text-sm">
        <b>{student.fullName}</b> · {student.rollNumber} · {student.program} {student.batch} · Semester {student.semester}
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Type">
          <select className="input-base" value={f.typeId} onChange={(e) => set("typeId", e.target.value)}>
            <option value="">Select type</option>
            {config.concessionTypes.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        {!waiver && (
          <>
            <Field label="Basis">
              <select className="input-base" value={f.mode} onChange={(e) => set("mode", e.target.value)}>
                <option value="PERCENT">Percentage</option>
                <option value="AMOUNT">Flat amount (Rs.)</option>
              </select>
            </Field>
            <Field label={f.mode === "PERCENT" ? "Percentage" : "Amount per challan"}>
              <input type="number" min="0" className="input-base" value={f.value} onChange={(e) => set("value", e.target.value)} />
            </Field>
          </>
        )}
      </div>
      {waiver && <p className="text-xs text-indigo-600">A full waiver removes 100% of the selected fee heads.</p>}
      <Field label="Applies to fee heads">
        <ChipSelect options={heads.map((h) => h.id)} value={f.headIds} onChange={(v) => set("headIds", v)} render={(id) => heads.find((h) => h.id === id)?.name} />
      </Field>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="From semester"><input type="number" min="1" className="input-base" value={f.startSemester} onChange={(e) => set("startSemester", e.target.value)} /></Field>
        <Field label="Duration">
          <select className="input-base" value={f.durationType} onChange={(e) => set("durationType", e.target.value)}>
            <option value="SEMESTERS">Number of semesters</option>
            <option value="UNTIL_LAST">Until the last semester</option>
          </select>
        </Field>
        {f.durationType === "SEMESTERS" && (
          <Field label="Semesters"><input type="number" min="1" className="input-base" value={f.semesters} onChange={(e) => set("semesters", e.target.value)} /></Field>
        )}
      </div>
      <Field label="Condition — minimum CGPA (optional)" hint="If the student's CGPA drops below this, the concession is flagged for your review before it applies again.">
        <input type="number" step="0.01" min="0" max="4" className="input-base w-40" value={f.minCgpa} onChange={(e) => set("minCgpa", e.target.value)} />
      </Field>
      <Field label="Reason (required)"><textarea className="input-base" rows={2} value={f.reason} onChange={(e) => set("reason", e.target.value)} /></Field>
      <Field label="Proof document (required)" hint="PDF, JPG or PNG up to 10 MB">
        <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="input-base" onChange={(e) => set("proof", e.target.files[0] || null)} />
      </Field>
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? "Applying…" : "Apply Concession"}</button>
      </div>
    </div>
  );
};

const Concessions = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const isProvost = user?.role === "provost";
  const [list, setList] = useState("");
  const [filters, setFilters] = useState({ program: "", batch: "", semester: "" });
  const { data: config } = useApi(() => api.fees.config(), []);
  const fetcher = useCallback(() => api.fees.concessions({ ...filters, list }), [filters, list]);
  const { data, loading, error, reload } = useApi(fetcher, [filters, list]);

  const [search, setSearch] = useState({ q: "", program: "", batch: "", semester: "" });
  const [results, setResults] = useState(null);
  const [applyFor, setApplyFor] = useState(null);
  const [trail, setTrail] = useState(null);
  const [revise, setRevise] = useState(null);
  const [revoke, setRevoke] = useState(null);

  const doSearch = async () => {
    try { setResults((await api.fees.students(search)).items); } catch (e) { toast(e.message, { type: "error" }); }
  };
  const showTrail = async (c) => {
    try { setTrail({ c, items: (await api.fees.concessionTrail(c.id)).items }); } catch (e) { toast(e.message, { type: "error" }); }
  };
  const submitRevise = async () => {
    try {
      await api.fees.reviseConcession(revise.id, {
        value: Number(revise.value), minCgpa: revise.minCgpa === "" ? null : revise.minCgpa, reason: revise.note,
      });
      toast("Concession revised", { type: "success" });
      setRevise(null);
      reload();
    } catch (e) { toast(e.message, { type: "error" }); }
  };
  const submitRevoke = async () => {
    try {
      await api.fees.revokeConcession(revoke.id, revoke.note);
      toast("Concession revoked", { type: "success" });
      setRevoke(null);
      reload();
    } catch (e) { toast(e.message, { type: "error" }); }
  };
  const runReview = async () => {
    try {
      const r = await api.fees.reviewConcessions();
      toast(`${r.flagged} flagged for review, ${r.expired} expired`, { type: "success" });
      reload();
    } catch (e) { toast(e.message, { type: "error" }); }
  };

  return (
    <div>
      <PageHeader
        title="Concessions"
        subtitle="Fee reductions, full waivers and scholarships — applied automatically to each student's next challans"
        icon="BadgePercent"
        breadcrumb={[isProvost ? "Provost" : "Fees", "Concessions"]}
        actions={isProvost && <button className="btn-secondary text-sm" onClick={runReview}><ShieldCheck size={15} /> Check Conditions</button>}
      />

      {isProvost && (
        <div className="card-base p-4 mb-6">
          <p className="font-display font-bold text-app mb-3">Find a student</p>
          <FeeFilters options={config?.filters} value={search} onChange={setSearch} search>
            <button className="btn-primary text-sm py-2" onClick={doSearch}>Search</button>
          </FeeFilters>
          {results && (
            <Table
              rows={results}
              rowKey={(r) => r.studentId}
              empty="No students match"
              columns={[
                { key: "rollNumber", label: "Roll No" },
                { key: "registrationNumber", label: "Reg No" },
                { key: "fullName", label: "Name" },
                { key: "cnic", label: "CNIC" },
                { key: "program", label: "Program" },
                { key: "batch", label: "Batch" },
                { key: "semester", label: "Sem" },
                { key: "a", label: "", render: (s) => <button className="btn-ghost text-xs py-1" onClick={() => setApplyFor(s)}><Plus size={13} /> Concession</button> },
              ]}
            />
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-3 items-center justify-between">
        <div className="flex flex-wrap gap-1.5">
          {LISTS.map((l) => (
            <button key={l.key} onClick={() => setList(l.key)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${list === l.key ? "bg-primary-600 text-white border-primary-600" : "border-app text-muted-app"}`}>{l.label}</button>
          ))}
        </div>
        {list && <ExportButtons onExport={(format) => api.fees.exportConcessions(list, filters, format)} />}
      </div>
      <FeeFilters options={config?.filters} value={filters} onChange={setFilters} />

      {error ? <ErrorState description={error} onRetry={reload} />
        : loading ? <Skeleton className="h-64 rounded-2xl" />
        : (
          <Table
            rows={data?.items || []}
            empty="No concessions in this list"
            columns={[
              { key: "rollNumber", label: "Roll No" },
              { key: "name", label: "Student" },
              { key: "pb", label: "Program / Batch", render: (c) => `${c.program} · ${c.batch}` },
              { key: "typeName", label: "Type" },
              { key: "valueLabel", label: "Value" },
              { key: "heads", label: "Fee Heads" },
              { key: "coverage", label: "Coverage", render: (c) => <span>{c.coverage}{c.expiringSoon && <span className="ml-1 text-amber-600 text-xs">(ends this semester)</span>}</span> },
              { key: "minCgpa", label: "Condition", render: (c) => (c.minCgpa != null ? `CGPA ≥ ${c.minCgpa}` : "—") },
              { key: "status", label: "Status", render: (c) => <span title={c.reviewNote || c.revokeReason || ""}><FeeStatus status={c.status} /></span> },
              {
                key: "a", label: "", render: (c) => (
                  <div className="flex gap-1 justify-end">
                    <a className="btn-ghost text-xs py-1 px-2" href={fileUrl(c.proofPath)} target="_blank" rel="noreferrer">Proof</a>
                    <button className="btn-ghost text-xs py-1 px-2" onClick={() => showTrail(c)} title="Audit trail"><History size={13} /></button>
                    {isProvost && c.status !== "REVOKED" && (
                      <>
                        <button className="btn-ghost text-xs py-1 px-2" onClick={() => setRevise({ ...c, minCgpa: c.minCgpa ?? "", note: "" })} title="Revise"><Pencil size={13} /></button>
                        <button className="btn-ghost text-xs py-1 px-2 text-rose-600" onClick={() => setRevoke({ ...c, note: "" })} title="Revoke"><XCircle size={13} /></button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}

      <Modal open={!!applyFor} onClose={() => setApplyFor(null)} title="Apply Concession" icon={BadgePercent} maxWidth="max-w-3xl">
        {applyFor && config && <ApplyForm student={applyFor} config={config} onCancel={() => setApplyFor(null)} onDone={() => { setApplyFor(null); reload(); }} />}
      </Modal>

      <Modal open={!!revise} onClose={() => setRevise(null)} title="Revise Concession" subtitle={revise && `${revise.name} · ${revise.typeName}`}>
        {revise && (
          <div className="space-y-3">
            {revise.category !== "WAIVER" && (
              <Field label={revise.mode === "PERCENT" ? "Percentage" : "Amount"}><input type="number" className="input-base" value={revise.value} onChange={(e) => setRevise({ ...revise, value: e.target.value })} /></Field>
            )}
            <Field label="Minimum CGPA (blank = none)"><input type="number" step="0.01" className="input-base" value={revise.minCgpa} onChange={(e) => setRevise({ ...revise, minCgpa: e.target.value })} /></Field>
            {revise.status === "REVIEW" && <p className="text-xs text-amber-600">{revise.reviewNote}. Saving reinstates the concession.</p>}
            <Field label="Reason for revision"><textarea className="input-base" rows={2} value={revise.note} onChange={(e) => setRevise({ ...revise, note: e.target.value })} /></Field>
            <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setRevise(null)}>Cancel</button><button className="btn-primary" onClick={submitRevise}>Save</button></div>
          </div>
        )}
      </Modal>

      <Modal open={!!revoke} onClose={() => setRevoke(null)} title="Revoke Concession" subtitle={revoke && `${revoke.name} · ${revoke.typeName}`}>
        {revoke && (
          <div className="space-y-3">
            <Field label="Reason"><textarea className="input-base" rows={2} value={revoke.note} onChange={(e) => setRevoke({ ...revoke, note: e.target.value })} /></Field>
            <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setRevoke(null)}>Cancel</button><button className="btn-primary bg-rose-600" onClick={submitRevoke}>Revoke</button></div>
          </div>
        )}
      </Modal>

      <Modal open={!!trail} onClose={() => setTrail(null)} title="Concession Audit Trail" subtitle={trail && `${trail.c.name} · ${trail.c.typeName}`} maxWidth="max-w-3xl">
        {trail && (
          <ol className="space-y-3">
            {trail.items.map((t) => (
              <li key={t.id} className="p-3 rounded-xl bg-app-subtle text-sm">
                <div className="flex justify-between"><b>{t.action.replace("CONCESSION_", "")}</b><span className="text-xs text-muted-app">{fmtDate(t.createdAt)} {new Date(t.createdAt).toLocaleTimeString()}</span></div>
                <div className="text-xs text-muted-app">by {t.actor || "System"}</div>
                {t.before && <pre className="text-[11px] mt-2 whitespace-pre-wrap">Before: {JSON.stringify(t.before)}</pre>}
                {t.after && <pre className="text-[11px] mt-1 whitespace-pre-wrap">After: {JSON.stringify(t.after)}</pre>}
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </div>
  );
};

export default Concessions;
