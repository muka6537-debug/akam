import { useState } from "react";
import { FileSpreadsheet, FileDown } from "lucide-react";
import { useToast } from "../../context/ToastContext";

const STATUS_STYLES = {
  PAID: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  PARTIAL: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  UNPAID: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  OVERDUE: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  WAIVED: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  ACTIVE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  REVIEW: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  REVOKED: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  EXPIRED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  CLOSED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

export const FeeStatus = ({ status }) => (
  <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLES[status] || STATUS_STYLES.UNPAID}`}>{status}</span>
);

// Program / Batch / Semester filter bar shared by every fee list.
export const FeeFilters = ({ options, value, onChange, search = false, children }) => {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="card-base p-3 mb-4 flex flex-wrap gap-2 items-center">
      {search && (
        <input className="input-base flex-1 min-w-[200px]" placeholder="Search Reg No, Roll No, Name or CNIC" value={value.q || ""} onChange={set("q")} />
      )}
      <select className="input-base w-auto" value={value.program || ""} onChange={set("program")}>
        <option value="">All programs</option>
        {(options?.programs || []).map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <select className="input-base w-auto" value={value.batch || ""} onChange={set("batch")}>
        <option value="">All batches</option>
        {(options?.batches || []).map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
      <select className="input-base w-auto" value={value.semester || ""} onChange={set("semester")}>
        <option value="">All semesters</option>
        {(options?.semesters || []).map((s) => <option key={s} value={s}>Semester {s}</option>)}
      </select>
      {children}
    </div>
  );
};

export const ExportButtons = ({ onExport }) => {
  const { toast } = useToast();
  const [busy, setBusy] = useState(null);
  const run = async (format) => {
    setBusy(format);
    try { await onExport(format); } catch (e) { toast(e.message || "Export failed", { type: "error" }); } finally { setBusy(null); }
  };
  return (
    <div className="flex gap-2">
      <button onClick={() => run("xlsx")} disabled={!!busy} className="btn-secondary text-sm py-2 px-3 disabled:opacity-50">
        <FileSpreadsheet size={14} /> {busy === "xlsx" ? "Exporting…" : "Excel"}
      </button>
      <button onClick={() => run("pdf")} disabled={!!busy} className="btn-primary text-sm py-2 px-3 disabled:opacity-50">
        <FileDown size={14} /> {busy === "pdf" ? "Exporting…" : "PDF"}
      </button>
    </div>
  );
};

export const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="text-xs font-semibold text-muted-app uppercase tracking-wide">{label}</span>
    <div className="mt-1">{children}</div>
    {hint && <span className="text-[11px] text-muted-app mt-1 block">{hint}</span>}
  </label>
);

// Simple multi-select rendered as toggle chips.
export const ChipSelect = ({ options, value, onChange, render = (o) => o }) => (
  <div className="flex flex-wrap gap-1.5">
    {options.map((o) => {
      const on = value.includes(o);
      return (
        <button type="button" key={o} onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
          className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition ${on ? "bg-primary-600 text-white border-primary-600" : "border-app text-muted-app hover:border-primary-400"}`}>
          {render(o)}
        </button>
      );
    })}
  </div>
);

export const Table = ({ columns, rows, empty = "No records", rowKey = (r) => r.id }) => (
  <div className="card-base overflow-hidden">
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-app text-xs uppercase tracking-wide border-b border-app bg-app-subtle">
            {columns.map((c) => <th key={c.key} className={`py-3 px-4 whitespace-nowrap ${c.right ? "text-right" : ""}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="py-10 text-center text-muted-app">{empty}</td></tr>
          ) : rows.map((r) => (
            <tr key={rowKey(r)} className="border-b border-app/40 last:border-0 hover:bg-app-subtle/50">
              {columns.map((c) => (
                <td key={c.key} className={`py-2.5 px-4 ${c.right ? "text-right tabular-nums" : ""}`}>{c.render ? c.render(r) : (r[c.key] ?? "—")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);
