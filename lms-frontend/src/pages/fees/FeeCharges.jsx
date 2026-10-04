import { useState } from "react";
import { Receipt } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { money } from "../../utils/feeFormat";
import { FeeFilters, Field } from "../../components/fees/feeUi";

// One-off fee charges. Finance: frozen / vacant semester, resit, late
// registration. Course Coordinator: special-semester fee, resit, late
// registration.
const FeeCharges = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const isFinance = user?.role === "finance";
  const isCoordinator = user?.role === "admin";
  const { data: config } = useApi(() => api.fees.config(), []);
  const rates = config?.rates || {};

  const [search, setSearch] = useState({ q: "", program: "", batch: "", semester: "" });
  const [students, setStudents] = useState([]);
  const [selected, setSelected] = useState([]);
  const [kind, setKind] = useState(isCoordinator ? "SPECIAL" : "FREEZE");
  const [form, setForm] = useState({ mode: "FREEZE", courses: "", amount: "", title: "", note: "" });
  const [busy, setBusy] = useState(false);

  const find = async () => {
    try { setStudents((await api.fees.students(search)).items); setSelected([]); } catch (e) { toast(e.message, { type: "error" }); }
  };
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : kind === "SPECIAL" ? [...s, id] : [id]));

  const submit = async () => {
    if (!selected.length) return toast("Select a student", { type: "error" });
    setBusy(true);
    try {
      const studentId = selected[0];
      if (kind === "FREEZE") await api.fees.chargeFreeze({ studentId, mode: form.mode, note: form.note });
      if (kind === "RESIT") await api.fees.chargeResit({ studentId, courses: form.courses.split(",").map((c) => c.trim()).filter(Boolean) });
      if (kind === "LATE") await api.fees.chargeLateRegistration({ studentId, amount: form.amount || undefined, note: form.note });
      if (kind === "SPECIAL") await api.fees.chargeSpecialSemester({ studentIds: selected, amount: Number(form.amount), title: form.title, note: form.note });
      toast("Challan generated — student notified", { type: "success" });
      setSelected([]);
    } catch (e) {
      toast(e.message, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const KINDS = [
    isFinance && { key: "FREEZE", label: "Frozen / Vacant Semester", note: "25% of the batch's locked semester fee" },
    { key: "RESIT", label: "Resit", note: `${money(rates.RESIT_PER_COURSE)} per course` },
    { key: "LATE", label: "Late Registration", note: `Default ${money(rates.LATE_REGISTRATION)}` },
    isCoordinator && { key: "SPECIAL", label: "Special Semester", note: "Amount set by the Course Coordinator" },
  ].filter(Boolean);

  return (
    <div>
      <PageHeader title="Fee Charges" subtitle="Generate challans for frozen semesters, resits, special semesters and late registration" icon="Receipt" breadcrumb={["Fees", "Charges"]} />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {KINDS.map((k) => (
          <button key={k.key} onClick={() => { setKind(k.key); setSelected([]); }} className={`card-base p-4 text-left ${kind === k.key ? "ring-2 ring-primary-500" : ""}`}>
            <p className="font-semibold text-app text-sm">{k.label}</p>
            <p className="text-xs text-muted-app mt-1">{k.note}</p>
          </button>
        ))}
      </div>

      <FeeFilters options={config?.filters} value={search} onChange={setSearch} search>
        <button className="btn-primary text-sm py-2" onClick={find}>Find Students</button>
      </FeeFilters>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 card-base p-3 max-h-[420px] overflow-y-auto">
          {students.length === 0 ? <p className="text-sm text-muted-app p-4">Search for students to charge.</p> : students.map((s) => (
            <label key={s.studentId} className="flex items-center gap-3 p-2 rounded-lg hover:bg-app-subtle cursor-pointer text-sm">
              <input type={kind === "SPECIAL" ? "checkbox" : "radio"} checked={selected.includes(s.studentId)} onChange={() => toggle(s.studentId)} />
              <span className="font-semibold">{s.rollNumber}</span><span>{s.fullName}</span>
              <span className="text-xs text-muted-app ml-auto">{s.program} · {s.batch} · Sem {s.semester}</span>
            </label>
          ))}
        </div>
        <div className="card-base p-4 space-y-3">
          {kind === "FREEZE" && (
            <Field label="Type">
              <select className="input-base" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="FREEZE">Frozen semester</option>
                <option value="VACANT">Vacant semester</option>
              </select>
            </Field>
          )}
          {kind === "RESIT" && <Field label="Course codes" hint="Comma separated, e.g. CS-101, MTH-101"><input className="input-base" value={form.courses} onChange={(e) => setForm({ ...form, courses: e.target.value })} /></Field>}
          {kind === "SPECIAL" && <Field label="Title"><input className="input-base" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Special Semester Fee — Summer 2027" /></Field>}
          {(kind === "SPECIAL" || kind === "LATE") && (
            <Field label="Amount (Rs.)"><input type="number" min="0" className="input-base" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
          )}
          {kind !== "RESIT" && <Field label="Note (optional)"><input className="input-base" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>}
          <p className="text-xs text-muted-app">{selected.length} student(s) selected</p>
          <button className="btn-primary w-full" disabled={busy} onClick={submit}><Receipt size={15} /> {busy ? "Generating…" : "Generate Challan"}</button>
        </div>
      </div>
    </div>
  );
};

export default FeeCharges;
