import { useCallback, useState } from "react";
import PageHeader from "../../components/common/PageHeader";
import ErrorState from "../../components/common/ErrorState";
import { Skeleton } from "../../components/common/Skeleton";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { money, fmtDate } from "../../utils/feeFormat";
import { FeeFilters, ExportButtons, Table } from "../../components/fees/feeUi";

// Students on hold for overdue dues. Shared by the Provost, Finance and
// the Focal Person.
const FeeDefaulters = () => {
  const [filters, setFilters] = useState({ q: "", program: "", batch: "", semester: "" });
  const { data: config } = useApi(() => api.fees.config(), []);
  const fetcher = useCallback(() => api.fees.defaulters(filters), [filters]);
  const { data, loading, error, reload } = useApi(fetcher, [filters]);
  const items = data?.items || [];

  return (
    <div>
      <PageHeader
        title="Fee Defaulters"
        subtitle="Students with overdue dues — blocked from course registration and admit cards, promotion on Hold"
        icon="UserX"
        breadcrumb={["Fees", "Defaulters"]}
        actions={<ExportButtons onExport={(format) => api.fees.exportDefaulters(filters, format)} />}
      />
      <FeeFilters options={config?.filters} value={filters} onChange={setFilters} search />
      {error ? <ErrorState description={error} onRetry={reload} />
        : loading ? <Skeleton className="h-64 rounded-2xl" />
        : (
          <>
            <p className="text-xs text-muted-app mb-2">{items.length} student(s) on hold · Outstanding {money(items.reduce((s, d) => s + d.outstanding, 0))}</p>
            <Table
              rows={items}
              rowKey={(r) => r.studentId}
              empty="No students are on hold for unpaid dues"
              columns={[
                { key: "rollNumber", label: "Roll No" },
                { key: "name", label: "Student" },
                { key: "program", label: "Program" },
                { key: "batch", label: "Batch" },
                { key: "semester", label: "Sem" },
                { key: "overdueChallans", label: "Overdue", right: true },
                { key: "outstanding", label: "Outstanding", right: true, render: (d) => money(d.outstanding) },
                { key: "oldestDue", label: "Oldest Due", render: (d) => fmtDate(d.oldestDue) },
                { key: "daysOverdue", label: "Days", right: true },
                { key: "holds", label: "Blocked From", render: (d) => <span className="text-xs text-rose-600">{d.holds}</span> },
              ]}
            />
          </>
        )}
    </div>
  );
};

export default FeeDefaulters;
