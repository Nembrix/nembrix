import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Play, X } from "lucide-react";
import * as api from "@/ipc/commands";
import { asTransaction, emitDdl } from "./emitDdl";
import type { OverlayState } from "./overlay";

interface Props {
  connId: string;
  schemaName: string;
  state: OverlayState;
  onClose: () => void;
  /** Called after a successful run so the canvas can reset overlay flags. */
  onApplied: () => void;
}

/**
 * Apply-overlay-as-DDL dialog. Shows the SQL the ER editor will run,
 * lets the user copy it for offline review, and runs the whole batch
 * inside a single transaction so a runtime error rolls back cleanly.
 *
 * Three phases: preview → running → done (success or error).
 */
export default function ApplyDialog({ connId, schemaName, state, onClose, onApplied }: Props) {
  const plan = useMemo(() => emitDdl(state, schemaName), [state, schemaName]);
  const txSql = useMemo(() => asTransaction(plan), [plan]);
  const [phase, setPhase] = useState<"preview" | "running" | "done">("preview");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset the copied-confirmation toast a beat after it flashes.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const run = async () => {
    setPhase("running");
    setErr(null);
    try {
      await api.execute(connId, txSql);
      setPhase("done");
      onApplied();
    } catch (e) {
      setErr(String(e));
      setPhase("preview");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(txSql);
      setCopied(true);
    } catch { /* clipboard blocked — silently ignore, user can select manually */ }
  };

  const empty = plan.statements.length === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal er-apply-modal"
        style={{ width: 720, maxWidth: "95vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <strong>Apply ER edits</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {phase === "done" ? (
          <div className="modal-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: 24 }}>
            <CheckCircle2 size={36} className="success-icon" />
            <strong>Applied.</strong>
            <span className="muted">{plan.statements.length} statement{plan.statements.length === 1 ? "" : "s"} ran successfully.</span>
            <button className="btn-pill primary" onClick={onClose} style={{ marginTop: 8 }}>Done</button>
          </div>
        ) : (
          <>
            <div className="modal-body" style={{ padding: 0 }}>
              {empty ? (
                <div className="placeholder muted" style={{ padding: 24 }}>
                  Nothing to apply — overlay matches the live schema.
                </div>
              ) : (
                <div className="er-apply-preview">
                  <div className="er-apply-meta muted">
                    {plan.statements.length} statement{plan.statements.length === 1 ? "" : "s"}, in a single transaction.
                    Errors during run roll the whole batch back.
                  </div>
                  <pre className="er-apply-sql mono">{txSql}</pre>
                </div>
              )}

              {err && (
                <div className="message-pane err" style={{ margin: 8 }}>
                  <AlertTriangle size={11} /> {err}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn-pill" onClick={copy} disabled={empty}>
                <Copy size={11} /> {copied ? "Copied" : "Copy SQL"}
              </button>
              <div className="spacer" />
              <button className="btn-pill" onClick={onClose}>Cancel</button>
              <button
                className="btn-pill primary"
                onClick={() => void run()}
                disabled={empty || phase === "running"}
              >
                <Play size={11} /> {phase === "running" ? "Running…" : "Run in transaction"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
