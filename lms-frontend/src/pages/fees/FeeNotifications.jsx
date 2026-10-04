import { useState } from "react";
import { Megaphone, Plus, RefreshCw, Trash2, Eye } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import Modal from "../../components/common/Modal";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import { Skeleton } from "../../components/common/Skeleton";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { money, fmtDate } from "../../utils/feeFormat";
import { FeeStatus, Field, ChipSelect, Table } from "../../components/fees/feeUi";

const BLANK = {
  title: "", description: "", programs: [], batches: [], semesters: [],
  includeSemesterDues: true, items: [], dueDate: "", lateFeeType: "NONE", lateFeeAmount: "",
};

const Progress = ({ p }) => (
  <div className="text-xs text-muted-app space-y-1">
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <span><b className="text-app">{p.challans}</b> challans</span>
      <span className="text-emerald-600">{p.paid} paid</span>
      <span className="text-amber-600">{p.partial} partial</span>
      <span>{p.unpaid} unpaid</span>
      <span className="text-rose-600">{p.overdue} overdue</span>
    </div>
    <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
      <div className="h-full bg-emerald-500" style={{ width: `${p.collectionRate}%` }} />
    </div>
    <div>{money(p.collected)} of {money(p.billed)} collected ({p.collectionRate}%)</div>
  </div>
);

const FeeNotifications = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const isProvost = user?.role === "provost";
  const { data, loading, error, reload } = useApi(() => api.fees.notifications(), []);
  const { data: config } = useApi(() => api.fees.config(), []);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);

  const heads = (config?.heads || []).filter((h) => h.isActive && h.category !== "SEMESTER");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const announce = async () => {
    setSaving(true);
    try {
      const r = await api.fees.announce({
        ...form,
        semesters: form.semesters.map(Number),
        items: form.items.filter((i) => i.name && Number(i.amount) > 0).map((i) => ({ ...i, amount: Number(i.amount) })),
        lateFeeAmount: Number(form.lateFeeAmount) || 0,
      });
      toast(`Announced — ${r.generated} challan(s) generated${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`, { type: "success" });
      setForm(null);
      reload();
    } catch (e) {
      toast(e.message, { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (n) => {
    try { setDetail(await api.fees.notification(n.id)); } catch (e) { toast(e.message, { type: "error" }); }
  };

  const act = async (fn, msg) => {
    try { const r = await fn(); toast(msg(r), { type: "success" }); reload(); } catch (e) { toast(e.message, { type: "error" }); }
  };

  const items = data?.items || [];

  return (
    <div>
      <PageHeader
        title="Fee Notifications"
        subtitle="Announce fees to programs, batches and semesters — challans are generated for every student automatically"
        icon="Megaphone"
        breadcrumb={[isProvost ? "Provost" : "Fees", "Fee Notifications"]}
        actions={isProvost && <button className="btn-primary text-sm" onClick={() => setForm(BLANK)}><Plus size={15} /> Announce Fee</button>}
      />

      {error ? <ErrorState description={error} onRetry={reload} />
        : loading ? <Skeleton className="h-64 rounded-2xl" />
        : items.length === 0 ? <EmptyState icon="Megaphone" title="No fee notifications yet" description="Announced fee notifications and their payment progress appear here." />
        : (
          <div className="grid gap-4 lg:grid-cols-2">
            {items.map((n) => (
              <div key={n.id} className="card-base p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-display font-bold text-app">{n.title}</p>
                    <p className="text-xs text-muted-app mt-0.5">
                      {n.programs.join(", ")} · {n.batches.join(", ")} · Sem {n.semesters.join(", ")} · Due {fmtDate(n.dueDate)}
                    </p>
                  </div>
                  <FeeStatus status={n.status} />
                </div>
                <div className="text-xs text-muted-app">
                  {n.includeSemesterDues && <span className="mr-2">Semester dues from batch structure</span>}
                  {n.items.map((i) => <span key={i.name} className="mr-2">+ {i.name} {money(i.amount)}</span>)}
                  {n.lateFeeType !== "NONE" && <span className="text-rose-600">Late fee {money(n.lateFeeAmount)}{n.lateFeeType === "PER_DAY" ? "/day" : ""}</span>}
                </div>
                <Progress p={n.progress} />
                {n.skipped.length > 0 && (
                  <p className="text-xs text-amber-600">{n.skipped.length} student(s) skipped — {n.skipped[0].reason}</p>
                )}
                <div className="flex gap-2 pt-1">
                  <button className="btn-ghost text-xs py-1.5" onClick={() => openDetail(n)}><Eye size={14} /> Challans</button>
                  {isProvost && n.status === "ACTIVE" && (
                    <>
                      <button className="btn-ghost text-xs py-1.5" onClick={() => act(() => api.fees.regenerate(n.id), (r) => `${r.generated} new challan(s) generated`)}><RefreshCw size={14} /> Regenerate</button>
                      <button className="btn-ghost text-xs py-1.5 text-rose-600" onClick={() => act(() => api.fees.closeNotification(n.id), () => "Notification closed")}><Trash2 size={14} /> Close</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      <Modal open={!!form} onClose={() => setForm(null)} title="Announce Fee Notification" subtitle="Each student's challan reflects their batch's locked fee and concessions" icon={Megaphone} maxWidth="max-w-3xl">
        {form && config && (
          <div className="space-y-4">
            <Field label="Title"><input className="input-base" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Spring 2027 Semester Fee" /></Field>
            <Field label="Programs"><ChipSelect options={config.filters.programs} value={form.programs} onChange={(v) => set("programs", v)} /></Field>
            <Field label="Batches"><ChipSelect options={config.filters.batches} value={form.batches} onChange={(v) => set("batches", v)} /></Field>
            <Field label="Semesters">
              <ChipSelect options={["1", "2", "3", "4", "5", "6", "7", "8"]} value={form.semesters} onChange={(v) => set("semesters", v)} render={(s) => `Sem ${s}`} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.includeSemesterDues} onChange={(e) => set("includeSemesterDues", e.target.checked)} />
              Include semester dues from each batch's fee structure (locked semester fee, one-time heads in semester 1, recurring heads)
            </label>
            <Field label="Additional fee heads">
              <div className="space-y-2">
                {form.items.map((it, i) => (
                  <div key={i} className="flex gap-2">
                    <select className="input-base flex-1" value={it.headId || ""} onChange={(e) => {
                      const h = heads.find((x) => String(x.id) === e.target.value);
                      set("items", form.items.map((x, j) => (j === i ? { ...x, headId: h?.id, name: h?.name || "" } : x)));
                    }}>
                      <option value="">Select fee head</option>
                      {heads.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                    </select>
                    <input className="input-base w-36" type="number" min="0" placeholder="Amount" value={it.amount}
                      onChange={(e) => set("items", form.items.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                    <button type="button" className="btn-ghost px-2" onClick={() => set("items", form.items.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                  </div>
                ))}
                <button type="button" className="btn-ghost text-xs" onClick={() => set("items", [...form.items, { headId: null, name: "", amount: "" }])}><Plus size={14} /> Add fee head</button>
              </div>
            </Field>
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="Last date for payment"><input type="date" className="input-base" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} /></Field>
              <Field label="Late fee">
                <select className="input-base" value={form.lateFeeType} onChange={(e) => set("lateFeeType", e.target.value)}>
                  <option value="NONE">None</option>
                  <option value="FLAT">Flat amount</option>
                  <option value="PER_DAY">Per day after due date</option>
                </select>
              </Field>
              {form.lateFeeType !== "NONE" && (
                <Field label="Late fee amount"><input type="number" min="0" className="input-base" value={form.lateFeeAmount} onChange={(e) => set("lateFeeAmount", e.target.value)} /></Field>
              )}
            </div>
            <Field label="Description (optional)"><textarea className="input-base" rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn-primary" disabled={saving} onClick={announce}>{saving ? "Announcing…" : "Announce & Generate Challans"}</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.notification.title} subtitle="Per-student challans and payment status" maxWidth="max-w-5xl">
        {detail && (
          <Table
            rows={detail.challans}
            columns={[
              { key: "rollNumber", label: "Roll No" },
              { key: "name", label: "Student" },
              { key: "challanNo", label: "Challan" },
              { key: "discountAmount", label: "Concession", right: true, render: (c) => (c.discountAmount ? money(c.discountAmount) : "—") },
              { key: "payable", label: "Net Due", right: true, render: (c) => money(c.payable) },
              { key: "paidAmount", label: "Paid", right: true, render: (c) => money(c.paidAmount) },
              { key: "status", label: "Status", render: (c) => <FeeStatus status={c.status} /> },
            ]}
          />
        )}
      </Modal>
    </div>
  );
};

export default FeeNotifications;
