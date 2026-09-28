import { useEffect, useRef, useState } from "react";
import { Lock, ShieldCheck, KeyRound, Loader2, AlertTriangle, LogOut } from "lucide-react";
import api, { marksSession } from "../../services/api";

/* =============================================================
   MarksPinGate — A4 security gate for the teacher Marks module.
   • Separate 5-digit numeric PIN (distinct from login password).
   • First access: set PIN (+ account password as second factor).
   • EVERY mount clears the in-memory session, so opening the module,
     refreshing, a new tab or browser back always re-prompts.
   • Children are not rendered at all until the PIN is verified.
   • Auto-locks after 5 minutes of inactivity and when the server
     reports the marks session expired (423).
   • Server enforces lockout after 5 wrong attempts (15 min).
   ============================================================= */
const IDLE_MS = 5 * 60 * 1000;

function PinBoxes({ value, onChange, autoFocus, disabled, label }) {
  const refs = useRef([]);
  const digits = (value || "").padEnd(5, " ").slice(0, 5).split("");
  const setAt = (i, ch) => {
    const arr = (value || "").split("");
    arr[i] = ch;
    const next = arr.join("").replace(/\s/g, "").slice(0, 5);
    onChange(next);
  };
  return (
    <div>
      {label && <p className="text-xs font-semibold text-secondary-app mb-1.5">{label}</p>}
      <div className="flex gap-2">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => { refs.current[i] = el; }}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={1}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            value={d.trim()}
            onChange={(e) => {
              const ch = e.target.value.replace(/\D/g, "").slice(-1);
              if (!ch) return;
              setAt(i, ch);
              if (i < 4) refs.current[i + 1]?.focus();
            }}
            onKeyDown={(e) => {
              if (e.key === "Backspace") {
                e.preventDefault();
                const arr = (value || "").split("");
                if (arr[i]) { arr[i] = ""; onChange(arr.join("")); }
                else if (i > 0) { refs.current[i - 1]?.focus(); arr[i - 1] = ""; onChange(arr.join("")); }
              }
            }}
            onPaste={(e) => {
              const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 5);
              if (t) { e.preventDefault(); onChange(t); refs.current[Math.min(t.length, 4)]?.focus(); }
            }}
            className="w-12 h-14 text-center text-2xl font-bold rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:border-primary-500 focus:outline-none"
          />
        ))}
      </div>
    </div>
  );
}

export default function MarksPinGate({ children, title = "Marks Module" }) {
  const [unlocked, setUnlocked] = useState(false);
  const [status, setStatus] = useState(null);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Always start locked on mount (no bypass via back/refresh/re-open).
  // `unlocked` starts false; clearing the shared token here guarantees no
  // earlier session from another screen is reused.
  useEffect(() => {
    marksSession.clear();
    api.marks.pinStatus().then(setStatus).catch((e) => setError(e.message));
    const unsub = marksSession.subscribe((t) => { if (!t) setUnlocked(false); });
    return () => { unsub(); marksSession.clear(); };
  }, []);

  // Idle auto-lock.
  useEffect(() => {
    if (!unlocked) return undefined;
    let timer = setTimeout(() => marksSession.clear(), IDLE_MS);
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => marksSession.clear(), IDLE_MS); };
    const evs = ["mousemove", "keydown", "click", "scroll"];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const onHide = () => { if (document.visibilityState === "hidden") bump(); };
    document.addEventListener("visibilitychange", onHide);
    return () => { clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, bump)); document.removeEventListener("visibilitychange", onHide); };
  }, [unlocked]);

  const refreshStatus = () => api.marks.pinStatus().then(setStatus).catch(() => {});

  const doUnlock = async (e) => {
    e?.preventDefault();
    if (pin.length !== 5) { setError("Enter all 5 digits."); return; }
    setBusy(true); setError("");
    try {
      const r = await api.marks.unlock(pin);
      marksSession.set(r.token);
      setUnlocked(true);
    } catch (err) {
      setError(err.message);
      refreshStatus();
    } finally { setPin(""); setBusy(false); }
  };

  const doSetup = async (e) => {
    e.preventDefault();
    if (pin.length !== 5) { setError("PIN must be exactly 5 digits."); return; }
    if (pin !== confirm) { setError("PIN and confirmation do not match."); return; }
    setBusy(true); setError("");
    try {
      const r = await api.marks.setupPin({ pin, confirmPin: confirm, password });
      marksSession.set(r.token);
      setUnlocked(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); setPin(""); setConfirm(""); setPassword(""); }
  };

  if (unlocked) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 px-3 py-2">
          <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
            <ShieldCheck size={14} /> {title} unlocked — auto-locks after 5 minutes of inactivity
          </span>
          <button onClick={() => marksSession.clear()} className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:underline flex items-center gap-1">
            <LogOut size={12} /> Lock now
          </button>
        </div>
        {children}
      </div>
    );
  }

  const locked = status?.locked;
  return (
    <div className="max-w-md mx-auto mt-6">
      <div className="card-base p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-xl bg-primary-50 dark:bg-primary-500/10 text-primary-600 flex items-center justify-center">
            {status && !status.isSet ? <KeyRound size={20} /> : <Lock size={20} />}
          </div>
          <div>
            <h2 className="font-display font-bold text-lg text-app">{title} is locked</h2>
            <p className="text-xs text-muted-app">
              {status && !status.isSet ? "Create your 5-digit Marks PIN to continue." : "Enter your 5-digit Marks PIN to continue."}
            </p>
          </div>
        </div>

        {!status ? (
          <div className="py-6 flex justify-center"><Loader2 className="animate-spin text-primary-600" /></div>
        ) : locked ? (
          <div className="rounded-xl bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 p-3 text-sm flex gap-2">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            Too many wrong attempts. The Marks module is locked until {new Date(status.lockedUntil).toLocaleTimeString()}.
          </div>
        ) : !status.isSet ? (
          <form onSubmit={doSetup} className="space-y-4">
            <p className="text-xs text-muted-app">This PIN is separate from your login password. You will need it every time you open Marks, Gradebook or Results Submission, and to publish or submit results.</p>
            <PinBoxes label="New PIN" value={pin} onChange={setPin} autoFocus disabled={busy} />
            <PinBoxes label="Confirm PIN" value={confirm} onChange={setConfirm} disabled={busy} />
            <div>
              <p className="text-xs font-semibold text-secondary-app mb-1.5">Account password (verification)</p>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-base w-full" />
            </div>
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <button disabled={busy} className="btn-primary w-full justify-center">{busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} Set PIN &amp; unlock</button>
          </form>
        ) : (
          <form onSubmit={doUnlock} className="space-y-4">
            <PinBoxes value={pin} onChange={setPin} autoFocus disabled={busy} />
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <p className="text-[11px] text-muted-app">{status.attemptsRemaining} attempt(s) remaining before a 15-minute lockout.</p>
            <button disabled={busy || pin.length !== 5} className="btn-primary w-full justify-center disabled:opacity-60">{busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />} Unlock</button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Confirmation popup that re-asks for the PIN (publish / final submission). */
export function PinConfirmModal(props) {
  // Keyed on `open` so the PIN field is always blank when the popup re-opens.
  if (!props.open) return null;
  return <PinConfirmBody key={props.openKey || "pin"} {...props} />;
}

function PinConfirmBody({ open, title, message, confirmLabel = "Confirm", danger = false, onClose, onConfirm }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!open) return null;
  const submit = async (e) => {
    e.preventDefault();
    if (pin.length !== 5) { setError("Enter your 5-digit PIN."); return; }
    setBusy(true); setError("");
    try { await onConfirm(pin); onClose(); }
    catch (err) { setError(err.message); setPin(""); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="card-base w-full max-w-md p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${danger ? "bg-rose-50 text-rose-600 dark:bg-rose-500/10" : "bg-primary-50 text-primary-600 dark:bg-primary-500/10"}`}><AlertTriangle size={18} /></div>
          <div>
            <h3 className="font-bold text-app">{title}</h3>
            <p className="text-sm text-muted-app mt-1">{message}</p>
          </div>
        </div>
        <PinBoxes label="Enter your 5-digit PIN to confirm" value={pin} onChange={setPin} autoFocus disabled={busy} />
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary text-sm">Cancel</button>
          <button disabled={busy || pin.length !== 5} className={`${danger ? "btn-primary bg-rose-600 hover:bg-rose-700" : "btn-primary"} text-sm disabled:opacity-60`}>
            {busy && <Loader2 size={14} className="animate-spin" />} {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
