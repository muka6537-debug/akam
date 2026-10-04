import { useCallback, useState } from "react";
import PageHeader from "../../components/common/PageHeader";
import StatCard from "../../components/common/StatCard";
import ErrorState from "../../components/common/ErrorState";
import { Skeleton } from "../../components/common/Skeleton";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { money, fmtDate } from "../../utils/feeFormat";
import { FeeStatus, FeeFilters, ExportButtons, Table } from "../../components/fees/feeUi";

const KINDS = [
  { key: "paid", label: "Paid" },
  { key: "unpaid", label: "Unpaid" },
  { key: "partial", label: "Partial" },
  { key: "overdue", label: "Overdue" },
];

const FeeReports = () => {
  const [kind, setKind] = useState("paid");
  const [filters, setFilters] = useState({ program: "", batch: "", semester: "" });
  const { data: config } = useApi(() => api.fees.config(), []);
  const { data: summary } = useApi(() => api.fees.summary(), []);
  const fetcher = useCallback(() => api.fees.report(kind, filters), [kind, filters]);
  const { data, loading, error, reload } = useApi(fetcher, [kind, filters]);
  const s = summary?.byStatus || {};

  return (
    <div>
      <PageHeader
        title="Fee Reports"
        subtitle="Paid, unpaid, partial and overdue challans by program, batch and semester"
        icon="FileBarChart"
        breadcrumb={["Fees", "Reports"]}
        actions={<ExportButtons onExport={(format) => api.fees.exportReport(kind, filters, format)} />}
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Billed" value={money(summary?.totals.billed)} icon="Receipt" color="blue" />
        <StatCard title="Collected" value={money(summary?.totals.collected)} icon="CheckCircle2" color="emerald" />
        <StatCard title="Concessions" value={money(summary?.totals.concessions)} icon="BadgePercent" color="purple" />
        <StatCard title="Defaulters" value={summary?.defaulters ?? "—"} icon="UserX" color="rose" />
      </div>
      <div className="flex gap-1.5 mb-3">
        {KINDS.map((k) => (
          <button key={k.key} onClick={() => setKind(k.key)}
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${kind === k.key ? "bg-primary-600 text-white border-primary-600" : "border-app text-muted-app"}`}>
            {k.label} ({s[k.key.toUpperCase()]?.count ?? 0})
          </button>
        ))}
      </div>
      <FeeFilters options={config?.filters} value={filters} onChange={setFilters} />
      {error ? <ErrorState description={error} onRetry={reload} />
        : loading ? <Skeleton className="h-64 rounded-2xl" />
        : (
          <>
            <p className="text-xs text-muted-app mb-2">
              {data.totals.count} challan(s) · Net due {money(data.totals.payable)} · Paid {money(data.totals.paid)} · Remaining {money(data.totals.remaining)}
            </p>
            <Table
              rows={data.rows}
              columns={[
                { key: "challanNo", label: "Challan" },
                { key: "rollNumber", label: "Roll No" },
                { key: "name", label: "Student" },
                { key: "pb", label: "Program / Batch", render: (c) => `${c.program || "—"} · ${c.batch || "—"}` },
                { key: "semester", label: "Sem" },
                { key: "title", label: "Title" },
                { key: "dueDate", label: "Due", render: (c) => fmtDate(c.dueDate) },
                { key: "payable", label: "Net Due", right: true, render: (c) => money(c.payable) },
                { key: "paidAmount", label: "Paid", right: true, render: (c) => money(c.paidAmount) },
                { key: "remaining", label: "Remaining", right: true, render: (c) => money(c.remaining) },
                { key: "status", label: "Status", render: (c) => <FeeStatus status={c.status} /> },
              ]}
            />
          </>
        )}
    </div>
  );
};

export default FeeReports;
