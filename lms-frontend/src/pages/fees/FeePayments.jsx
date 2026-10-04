import { useCallback, useState } from "react";
import { BadgeCheck, Download } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import Modal from "../../components/common/Modal";
import ErrorState from "../../components/common/ErrorState";
import { Skeleton } from "../../components/common/Skeleton";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useToast } from "../../context/ToastContext";
import { money, fmtDate } from "../../utils/feeFormat";
import { FeeStatus, FeeFilters, Field, Table } from "../../components/fees/feeUi";

// Finance confirms bank deposits, over-the-counter and gateway
// settlements against open challans.
const FeePayments = () => {
  const { toast } = useToast();
  const [filters, setFilters] = useState({ q: "", program: "", batch: "", semester: "" });
  const [status, setStatus] = useState("UNPAID,PARTIAL,OVERDUE");
  const { data: config } = useApi(() => api.fees.config(), []);
  const fetcher = useCallback(() => api.fees.challans({ ...filters, status }), [filters, status]);
  const { data, loading, error, reload } = useApi(fetcher, [filters, status]);
  const [pay, setPay] = useState(null);
  const [saving, setSaving] = useState(false);

  const methods = (config?.methods || []).filter((m) => m.isActive);

  const confirm = async () => {
    setSaving(true);
    try {
      await api.fees.recordPayment(pay.challan.id, {
        method: pay.method, reference: pay.reference, amount: pay.amount || undefined, note: pay.note, channel: pay.channel,
      });
      toast("Payment confirmed — student notified", { type: "success" });
      setPay(null);
      reload();
    } catch (e) {
      toast(e.message, { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Payments" subtitle="Confirm bank, counter and gateway payments against student challans" icon="BadgeCheck" breadcrumb={["Finance", "Payments"]} />
      <FeeFilters options={config?.filters} value={filters} onChange={setFilters} search>
        <select className="input-base w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="UNPAID,PARTIAL,OVERDUE">Open challans</option>
          <option value="PAID">Paid</option>
          <option value="WAIVED">Waived</option>
        </select>
      </FeeFilters>
      {error ? <ErrorState description={error} onRetry={reload} />
        : loading ? <Skeleton className="h-64 rounded-2xl" />
        : (
          <Table
            rows={data?.items || []}
            empty="No challans"
            columns={[
              { key: "challanNo", label: "Challan" },
              { key: "rollNumber", label: "Roll No" },
              { key: "name", label: "Student" },
              { key: "title", label: "Title" },
              { key: "dueDate", label: "Due", render: (c) => fmtDate(c.dueDate) },
              { key: "payable", label: "Net Due", right: true, render: (c) => money(c.payable) },
              { key: "remaining", label: "Remaining", right: true, render: (c) => money(c.remaining) },
              { key: "status", label: "Status", render: (c) => <FeeStatus status={c.status} /> },
              {
                key: "a", label: "", render: (c) => (
                  <div className="flex gap-1 justify-end">
                    <button className="btn-ghost text-xs py-1 px-2" onClick={() => api.fees.downloadChallan(c.id, c.challanNo)}><Download size={13} /></button>
                    {c.remaining > 0 && c.status !== "WAIVED" && (
                      <button className="btn-ghost text-xs py-1" onClick={() => setPay({ challan: c, method: methods.find((m) => m.confirmMode === "MANUAL")?.code || "", reference: "", amount: "", note: "", channel: "FINANCE" })}>
                        <BadgeCheck size={13} /> Confirm
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}

      <Modal open={!!pay} onClose={() => setPay(null)} title="Confirm Payment" subtitle={pay && `${pay.challan.challanNo} · ${pay.challan.name} · remaining ${money(pay.challan.remaining)}`} icon={BadgeCheck}>
        {pay && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Method">
                <select className="input-base" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                  {methods.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
                </select>
              </Field>
              <Field label="Source">
                <select className="input-base" value={pay.channel} onChange={(e) => setPay({ ...pay, channel: e.target.value })}>
                  <option value="FINANCE">Bank / counter report</option>
                  <option value="GATEWAY">Gateway settlement</option>
                </select>
              </Field>
            </div>
            <Field label="Bank / transaction reference"><input className="input-base" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
            <Field label="Amount" hint="Leave blank to settle the full remaining amount"><input type="number" min="0" className="input-base" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
            <Field label="Note (optional)"><input className="input-base" value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} /></Field>
            <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setPay(null)}>Cancel</button><button className="btn-primary" disabled={saving} onClick={confirm}>{saving ? "Saving…" : "Confirm Payment"}</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default FeePayments;
