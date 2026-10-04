import { useState } from "react";
import { motion } from "framer-motion";
import { Wallet, CheckCircle2, AlertTriangle, CalendarClock, BadgePercent, Receipt, CreditCard, Download, Lock } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import Modal from "../../components/common/Modal";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import EmptyState from "../../components/common/EmptyState";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useToast } from "../../context/ToastContext";
import { money, fmtDate } from "../../utils/feeFormat";
import { FeeStatus, Field } from "../../components/fees/feeUi";

const OPEN = ["UNPAID", "PARTIAL", "OVERDUE"];

const AccountBook = () => {
  const { toast } = useToast();
  const { data, loading, error, reload } = useApi(() => api.fees.me(), []);
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(false);

  const checkout = async () => {
    setBusy(true);
    try {
      const r = await api.fees.pay(pay.challan.id, { method: pay.method, amount: pay.amount || undefined });
      toast(r.challan.status === "PAID" ? "Payment confirmed — challan fully paid" : "Payment received", { type: "success" });
      setPay(null);
      reload();
    } catch (e) {
      toast(e.message, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const header = <PageHeader title="Fee Account" subtitle="Dues, challans, concessions and payment history" icon="Wallet" breadcrumb={["Dashboard", "Fee Account"]} />;
  if (loading) return <div>{header}<Skeleton className="h-64 rounded-2xl" /></div>;
  if (error) return <div>{header}<ErrorState description={error} onRetry={reload} /></div>;

  const { summary, challans, payments, hold, concessions, methods, admissionFees = [] } = data;
  const method = methods.find((m) => m.code === pay?.method);
  const cards = [
    { label: "Total Due", value: money(summary.totalDue), icon: Wallet, color: "from-blue-500 to-indigo-600" },
    { label: "Paid", value: money(summary.paid), icon: CheckCircle2, color: "from-emerald-500 to-teal-600" },
    { label: "Remaining", value: money(summary.remaining), icon: AlertTriangle, color: "from-rose-500 to-pink-600" },
    { label: "Deadline", value: fmtDate(summary.deadline), icon: CalendarClock, color: "from-amber-500 to-orange-600" },
    { label: "Concessions Applied", value: money(summary.concessions), icon: BadgePercent, color: "from-purple-500 to-violet-600" },
  ];

  return (
    <div>
      {header}
      {hold.onHold && (
        <div className="mb-5 p-4 rounded-2xl border border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-900 text-rose-700 dark:text-rose-300 flex gap-3">
          <Lock size={20} className="shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-bold">Academic hold — unpaid dues</p>
            <p>{hold.message} Course registration and admit card are blocked and your promotion is on Hold until the overdue challans are paid.</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        {cards.map((c, i) => (
          <motion.div key={c.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
            className={`bg-gradient-to-br ${c.color} rounded-2xl p-4 text-white`}>
            <c.icon size={20} className="mb-2" />
            <p className="font-display text-xl font-extrabold">{c.value}</p>
            <p className="text-xs opacity-90">{c.label}</p>
          </motion.div>
        ))}
      </div>

      {concessions.length > 0 && (
        <div className="card-base p-4 mb-6">
          <p className="font-display font-bold text-app mb-2">Concessions</p>
          <ul className="space-y-1.5 text-sm">
            {concessions.map((c) => (
              <li key={c.id} className="flex flex-wrap gap-x-2 items-center">
                <FeeStatus status={c.status} />
                <b>{c.typeName}</b> {c.valueLabel} on {c.heads} · {c.coverage}
                <span className="text-muted-app">— {c.reason}{c.minCgpa != null ? ` (maintain CGPA ≥ ${c.minCgpa})` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {challans.length === 0 ? (
        <EmptyState icon="Wallet" title="No challans yet" description="Fee challans appear here as soon as the university announces them." />
      ) : (
        <div className="space-y-4 mb-8">
          {challans.map((ch) => (
            <div key={ch.id} className="card-base overflow-hidden">
              <div className="px-5 py-4 border-b border-app flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-primary-50 dark:bg-primary-900/30"><Receipt size={20} className="text-primary-600" /></div>
                  <div>
                    <p className="font-display font-bold text-app">{ch.title}</p>
                    <p className="text-xs text-muted-app">Challan {ch.challanNo} · Semester {ch.semester ?? "—"} · Due {fmtDate(ch.dueDate)}</p>
                  </div>
                </div>
                <FeeStatus status={ch.status} />
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {ch.lineItems.map((it, j) => (
                    <tr key={j} className="border-b border-app/40 last:border-0">
                      <td className="py-1.5 px-5">{it.label}</td>
                      <td className="py-1.5 px-5 text-right text-xs text-purple-600">{it.concession ? `− ${money(it.concession)}` : ""}</td>
                      <td className="py-1.5 px-5 text-right font-semibold tabular-nums">{money(it.net ?? it.amount)}</td>
                    </tr>
                  ))}
                  {ch.lateFee > 0 && (
                    <tr><td className="py-1.5 px-5 text-rose-600">Late fee</td><td /><td className="py-1.5 px-5 text-right font-semibold text-rose-600">{money(ch.lateFee)}</td></tr>
                  )}
                </tbody>
              </table>
              <div className="px-5 py-3 bg-app-subtle flex items-center justify-between flex-wrap gap-2 text-sm">
                <span>Net {money(ch.payable)} · Paid {money(ch.paidAmount)} · <b>Remaining {money(ch.remaining)}</b></span>
                <div className="flex gap-2">
                  <button className="btn-ghost text-xs py-1.5" onClick={() => api.fees.downloadChallan(ch.id, ch.challanNo)}><Download size={14} /> Challan</button>
                  {OPEN.includes(ch.status) && (
                    <button className="btn-primary text-xs py-1.5" onClick={() => setPay({ challan: ch, method: methods[0]?.code, amount: "" })}><CreditCard size={14} /> Pay</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {admissionFees.length > 0 && (
        <div className="card-base p-4 mb-6">
          <p className="font-display font-bold text-app mb-3">Admission fees</p>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-app uppercase"><th className="py-2">Date</th><th>Fee</th><th>Reference</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {admissionFees.map((f) => (
                <tr key={f.id} className="border-t border-app/40">
                  <td className="py-2">{fmtDate(f.paidAt || f.createdAt)}</td>
                  <td>{f.title} <FeeStatus status={f.status} /></td>
                  <td className="text-xs">{f.paymentRef || f.challanNo}</td>
                  <td className="text-right font-semibold tabular-nums">{money(f.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-app mt-2">Paid during admissions; shown for your records.</p>
        </div>
      )}

      <div className="card-base p-4">
        <p className="font-display font-bold text-app mb-3">Payment history</p>
        {payments.length === 0 ? <p className="text-sm text-muted-app">No payments yet.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-app uppercase"><th className="py-2">Date</th><th>Challan</th><th>Method</th><th>Reference</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-t border-app/40">
                  <td className="py-2">{fmtDate(p.createdAt)}</td>
                  <td>{p.challanNo}</td>
                  <td>{methods.find((m) => m.code === p.method)?.label || p.method}</td>
                  <td className="text-xs">{p.reference}</td>
                  <td className="text-right font-semibold tabular-nums">{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={!!pay} onClose={() => setPay(null)} title="Pay Challan" subtitle={pay && `${pay.challan.challanNo} · remaining ${money(pay.challan.remaining)}`} icon={CreditCard}>
        {pay && (
          <div className="space-y-3">
            <Field label="Payment method">
              <select className="input-base" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                {methods.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
              </select>
            </Field>
            {method?.instructions && <p className="text-xs text-muted-app">{method.instructions}</p>}
            {method?.confirmMode === "INSTANT" ? (
              <>
                <Field label="Amount" hint="Leave blank to pay the full remaining amount">
                  <input type="number" min="0" className="input-base" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
                </Field>
                <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={checkout}>{busy ? "Processing…" : "Pay Now"}</button></div>
              </>
            ) : (
              <div className="flex justify-end">
                <button className="btn-secondary" onClick={() => api.fees.downloadChallan(pay.challan.id, pay.challan.challanNo)}><Download size={14} /> Download Challan</button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default AccountBook;
