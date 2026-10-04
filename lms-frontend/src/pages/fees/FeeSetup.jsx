import { useState } from "react";
import { Lock, Plus, Pencil } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import Modal from "../../components/common/Modal";
import ErrorState from "../../components/common/ErrorState";
import { Skeleton } from "../../components/common/Skeleton";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { money, fmtDate } from "../../utils/feeFormat";
import { Field, Table } from "../../components/fees/feeUi";

const CATEGORY_LABEL = { SEMESTER: "Recurring · locked", ONE_TIME: "One-time (1st semester)", OTHER: "Other", CHARGE: "Charge" };

// Fee heads, Program + Batch structures synced from admissions, payment
// methods and concession types. Finance edits; Provost manages types.
const FeeSetup = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const isFinance = user?.role === "finance";
  const isProvost = user?.role === "provost";
  const { data, loading, error, reload } = useApi(() => api.fees.config(), []);
  const [modal, setModal] = useState(null);

  const run = async (fn, msg) => {
    try { await fn(); toast(msg, { type: "success" }); setModal(null); reload(); } catch (e) { toast(e.message, { type: "error" }); }
  };

  if (error) return <ErrorState description={error} onRetry={reload} />;
  if (loading) return <Skeleton className="h-96 rounded-2xl" />;

  return (
    <div className="space-y-8">
      <PageHeader title="Fee Setup" subtitle="Fee heads, batch fee structures, payment methods and concession types" icon="Settings2" breadcrumb={["Fees", "Setup"]} />

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-display font-bold text-app">Program + Batch fee structures</h3>
          <span className="text-xs text-muted-app">Synced automatically when the Director Admissions announces a cycle</span>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {data.structures.length === 0 && <p className="text-sm text-muted-app">No structures synced yet.</p>}
          {data.structures.map((s) => (
            <div key={s.id} className="card-base p-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <p className="font-bold text-app">{s.programCode} — {s.batch}</p>
                  <p className="text-xs text-muted-app">Locked {fmtDate(s.lockedAt)} · last sync {fmtDate(s.syncedAt)}{s.syncedBy ? ` by ${s.syncedBy}` : ""}</p>
                </div>
                <span className="text-xs font-bold text-emerald-600 inline-flex items-center gap-1"><Lock size={12} /> {money(s.semesterFee)} / semester</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {s.items.map((i) => (
                    <tr key={i.headId} className="border-b border-app/40 last:border-0">
                      <td className="py-1.5">{i.name}</td>
                      <td className="py-1.5 text-xs text-muted-app">{CATEGORY_LABEL[i.category]}{i.category === "OTHER" ? ` · ${i.isRecurring ? "recurring" : "one-time"} · ${i.isLocked ? "locked" : "revisable"}` : ""}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(i.category === "SEMESTER" ? s.semesterFee : i.amount)}</td>
                      <td className="py-1.5 w-8 text-right">
                        {i.isLocked || i.category === "SEMESTER"
                          ? <Lock size={12} className="inline text-muted-app" />
                          : isFinance && <button className="btn-ghost px-1 py-0.5" onClick={() => setModal({ kind: "item", s, item: i, amount: i.amount })}><Pencil size={12} /></button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-display font-bold text-app">Fee heads</h3>
          {isFinance && <button className="btn-secondary text-sm py-2" onClick={() => setModal({ kind: "head", name: "", category: "OTHER", isRecurring: true, isLocked: false })}><Plus size={14} /> Add Fee Head</button>}
        </div>
        <Table
          rows={data.heads}
          columns={[
            { key: "name", label: "Fee Head" },
            { key: "category", label: "Category", render: (h) => CATEGORY_LABEL[h.category] },
            {
              key: "isRecurring", label: "One-time / Recurring", render: (h) => (h.category === "OTHER" && isFinance
                ? <button className="btn-ghost text-xs py-1" onClick={() => run(() => api.fees.updateHead(h.id, { isRecurring: !h.isRecurring }), "Fee head updated")}>{h.isRecurring ? "Recurring" : "One-time"}</button>
                : h.isRecurring ? "Recurring" : "One-time"),
            },
            {
              key: "isLocked", label: "Locked / Revisable", render: (h) => (h.category === "OTHER" && isFinance
                ? <button className="btn-ghost text-xs py-1" onClick={() => run(() => api.fees.updateHead(h.id, { isLocked: !h.isLocked }), "Fee head updated")}>{h.isLocked ? "Locked" : "Revisable"}</button>
                : h.isLocked ? "Locked" : "Revisable"),
            },
            {
              key: "isActive", label: "Active", render: (h) => (isFinance
                ? <button className="btn-ghost text-xs py-1" onClick={() => run(() => api.fees.updateHead(h.id, { isActive: !h.isActive }), "Fee head updated")}>{h.isActive ? "Active" : "Inactive"}</button>
                : h.isActive ? "Active" : "Inactive"),
            },
          ]}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-display font-bold text-app">Payment methods</h3>
            {isFinance && <button className="btn-secondary text-sm py-2" onClick={() => setModal({ kind: "method", code: "", label: "", confirmMode: "MANUAL", instructions: "" })}><Plus size={14} /> Add Method</button>}
          </div>
          <Table
            rows={data.methods}
            columns={[
              { key: "label", label: "Method" },
              { key: "confirmMode", label: "Confirmation", render: (m) => (m.confirmMode === "INSTANT" ? "Instant at checkout" : "Confirmed by Finance") },
              {
                key: "isActive", label: "", render: (m) => (isFinance
                  ? <button className="btn-ghost text-xs py-1" onClick={() => run(() => api.fees.updateMethod(m.id, { isActive: !m.isActive }), "Payment method updated")}>{m.isActive ? "Disable" : "Enable"}</button>
                  : m.isActive ? "Enabled" : "Disabled"),
              },
            ]}
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-display font-bold text-app">Concession types</h3>
            {isProvost && <button className="btn-secondary text-sm py-2" onClick={() => setModal({ kind: "type", name: "", category: "REDUCTION" })}><Plus size={14} /> Add Type</button>}
          </div>
          <Table rows={data.concessionTypes} columns={[{ key: "name", label: "Type" }, { key: "category", label: "Category" }]} />
        </div>
      </section>

      <Modal open={!!modal} onClose={() => setModal(null)} title={{ item: "Revise Fee Amount", head: "New Fee Head", method: "New Payment Method", type: "New Concession Type" }[modal?.kind]}>
        {modal?.kind === "item" && (
          <div className="space-y-3">
            <p className="text-sm">{modal.item.name} for {modal.s.programCode} — {modal.s.batch}</p>
            <Field label="Amount"><input type="number" min="0" className="input-base" value={modal.amount} onChange={(e) => setModal({ ...modal, amount: e.target.value })} /></Field>
            <div className="flex justify-end"><button className="btn-primary" onClick={() => run(() => api.fees.reviseStructureItem(modal.s.id, modal.item.headId, Number(modal.amount)), "Amount revised")}>Save</button></div>
          </div>
        )}
        {modal?.kind === "head" && (
          <div className="space-y-3">
            <Field label="Name"><input className="input-base" value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} /></Field>
            <Field label="Category">
              <select className="input-base" value={modal.category} onChange={(e) => setModal({ ...modal, category: e.target.value })}>
                <option value="ONE_TIME">One-time (first semester only)</option>
                <option value="OTHER">Other (configurable)</option>
                <option value="CHARGE">Charge (one-off)</option>
              </select>
            </Field>
            {modal.category === "OTHER" && (
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={modal.isRecurring} onChange={(e) => setModal({ ...modal, isRecurring: e.target.checked })} /> Recurring every semester</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={modal.isLocked} onChange={(e) => setModal({ ...modal, isLocked: e.target.checked })} /> Locked at admission</label>
              </div>
            )}
            <div className="flex justify-end"><button className="btn-primary" onClick={() => run(() => api.fees.createHead(modal), "Fee head added")}>Add</button></div>
          </div>
        )}
        {modal?.kind === "method" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code"><input className="input-base" value={modal.code} onChange={(e) => setModal({ ...modal, code: e.target.value.toUpperCase() })} placeholder="e.g. JAZZCASH" /></Field>
              <Field label="Label"><input className="input-base" value={modal.label} onChange={(e) => setModal({ ...modal, label: e.target.value })} /></Field>
            </div>
            <Field label="Confirmation">
              <select className="input-base" value={modal.confirmMode} onChange={(e) => setModal({ ...modal, confirmMode: e.target.value })}>
                <option value="INSTANT">Instant at checkout (gateway / wallet)</option>
                <option value="MANUAL">Confirmed by Finance (bank / counter)</option>
              </select>
            </Field>
            <Field label="Instructions for students"><textarea className="input-base" rows={2} value={modal.instructions} onChange={(e) => setModal({ ...modal, instructions: e.target.value })} /></Field>
            <div className="flex justify-end"><button className="btn-primary" onClick={() => run(() => api.fees.createMethod(modal), "Payment method added")}>Add</button></div>
          </div>
        )}
        {modal?.kind === "type" && (
          <div className="space-y-3">
            <Field label="Name"><input className="input-base" value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} placeholder="e.g. Sports Scholarship" /></Field>
            <Field label="Category">
              <select className="input-base" value={modal.category} onChange={(e) => setModal({ ...modal, category: e.target.value })}>
                <option value="WAIVER">Waiver</option>
                <option value="REDUCTION">Reduction</option>
                <option value="SCHOLARSHIP">Scholarship</option>
              </select>
            </Field>
            <div className="flex justify-end"><button className="btn-primary" onClick={() => run(() => api.fees.createConcessionType(modal), "Concession type added")}>Add</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default FeeSetup;
