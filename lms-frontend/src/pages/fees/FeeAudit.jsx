import { useCallback, useState } from "react";
import PageHeader from "../../components/common/PageHeader";
import ErrorState from "../../components/common/ErrorState";
import { Skeleton } from "../../components/common/Skeleton";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { Table } from "../../components/fees/feeUi";

const ENTITIES = [
  ["", "All fee activity"],
  ["BatchFeeStructure", "Fee structures"],
  ["FeeNotification", "Notifications"],
  ["LmsFeeChallan", "Challans & payments"],
  ["FeeConcession", "Concessions"],
  ["FeeHead", "Fee heads"],
  ["LmsPaymentMethod", "Payment methods"],
];

const diff = (r) => {
  if (!r.before && !r.after) return "—";
  const pick = (o) => (o ? JSON.stringify(o).slice(0, 160) : "");
  return (
    <div className="text-[11px] font-mono leading-snug max-w-md">
      {r.before && <div className="text-rose-600 truncate" title={JSON.stringify(r.before)}>− {pick(r.before)}</div>}
      {r.after && <div className="text-emerald-600 truncate" title={JSON.stringify(r.after)}>+ {pick(r.after)}</div>}
    </div>
  );
};

const FeeAudit = () => {
  const [entity, setEntity] = useState("");
  const fetcher = useCallback(() => api.fees.audit(entity ? { entity } : {}), [entity]);
  const { data, loading, error, reload } = useApi(fetcher, [entity]);

  return (
    <div>
      <PageHeader title="Fee Audit Log" subtitle="Who changed what and when — structures, notifications, concessions and payments" icon="ScrollText" breadcrumb={["Fees", "Audit Log"]} />
      <div className="card-base p-3 mb-4">
        <select className="input-base w-auto" value={entity} onChange={(e) => setEntity(e.target.value)}>
          {ENTITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {error ? <ErrorState description={error} onRetry={reload} />
        : loading ? <Skeleton className="h-64 rounded-2xl" />
        : (
          <Table
            rows={data?.items || []}
            columns={[
              { key: "createdAt", label: "When", render: (r) => new Date(r.createdAt).toLocaleString("en-GB") },
              { key: "actor", label: "Who", render: (r) => <span>{r.actor}<span className="block text-[11px] text-muted-app">{r.actorRole}</span></span> },
              { key: "action", label: "Action", render: (r) => <span className="font-semibold text-xs">{r.action}</span> },
              { key: "entity", label: "Record", render: (r) => `${r.entity} #${r.entityId ?? "—"}` },
              { key: "change", label: "Before / After", render: diff },
            ]}
          />
        )}
    </div>
  );
};

export default FeeAudit;
