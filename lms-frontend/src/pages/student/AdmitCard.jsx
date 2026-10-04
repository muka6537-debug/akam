import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, Lock, IdCard } from "lucide-react";
import PageHeader from "../../components/common/PageHeader";
import { Skeleton } from "../../components/common/Skeleton";
import ErrorState from "../../components/common/ErrorState";
import useApi from "../../hooks/useApi";
import api from "../../services/api";
import { useToast } from "../../context/ToastContext";

const AdmitCard = () => {
  const { toast } = useToast();
  const { data, loading, error, reload } = useApi(() => api.student.admitCard(), []);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try { await api.student.downloadAdmitCard(); } catch (e) { toast(e.message, { type: "error" }); } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="Admit Card" subtitle={data?.term ? `Examinations — ${data.term.title}` : "Examination admit card"} icon="IdCard" breadcrumb={["Dashboard", "Admit Card"]} />
      {error ? <ErrorState description={error} onRetry={reload} />
        : loading ? <Skeleton className="h-48 rounded-2xl" />
        : data.hold.onHold ? (
          <div className="card-base p-6 flex gap-4 items-start border-rose-200">
            <Lock className="text-rose-600 shrink-0" size={28} />
            <div>
              <p className="font-display font-bold text-app text-lg">Admit card on hold</p>
              <p className="text-sm text-muted-app mt-1">{data.hold.message}</p>
              <Link to="/student/account" className="btn-primary text-sm mt-4 inline-flex">Go to Fee Account</Link>
            </div>
          </div>
        ) : (
          <div className="card-base p-6">
            <div className="flex items-center justify-between mb-4">
              <p className="font-display font-bold text-app inline-flex items-center gap-2"><IdCard size={18} /> Registered courses</p>
              <button className="btn-primary text-sm" disabled={busy || !data.eligible} onClick={download}><Download size={15} /> {busy ? "Preparing…" : "Download Admit Card"}</button>
            </div>
            {data.courses.length === 0 ? (
              <p className="text-sm text-muted-app">You are not registered in any course this term.</p>
            ) : (
              <ul className="divide-y divide-app/40 text-sm">
                {data.courses.map((c) => <li key={c.offeringId} className="py-2"><b>{c.code}</b> — {c.title}</li>)}
              </ul>
            )}
          </div>
        )}
    </div>
  );
};

export default AdmitCard;
