import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RefreshCw, X, CheckCircle2, AlertTriangle } from "lucide-react";
import { useStore } from "@/store";
import { isTauri } from "@/ipc/commands";

/**
 * Auto-update flow for the desktop build.
 *
 * Lifecycle:
 *   - On launch (once, after a short delay) we run a SILENT check. If an
 *     update exists the dialog pops; if not, nothing is shown.
 *   - Help → "Check for Updates…" bumps `updateCheckTick`, which runs a
 *     MANUAL check. Manual checks always surface a result — including
 *     "you're on the latest version" — so the menu item never feels dead.
 *
 * Install is consent-gated: we download with a progress bar, then ask the
 * user to restart. We never relaunch without an explicit click.
 *
 * Browser / sidecar mode has no updater plugin. A silent check is a no-op;
 * a manual check shows a friendly "desktop only" note rather than erroring.
 *
 * The Tauri plugin APIs are imported dynamically so the browser bundle
 * never tries to resolve `@tauri-apps/plugin-updater` at module load.
 */

type Phase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error"
  | "unsupported";

interface UpdateInfo {
  version: string;
  notes?: string;
}

/** Minimal shape of the plugin's Update object we depend on. */
interface TauriUpdate {
  version: string;
  body?: string;
  downloadAndInstall: (
    onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
  ) => Promise<void>;
}

export default function UpdateDialog() {
  const manualTick = useStore((s) => s.updateCheckTick);

  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Download progress 0–1, or null while indeterminate. */
  const [progress, setProgress] = useState<number | null>(null);
  /** Whether the dialog is visible. Silent checks keep it hidden unless an
   *  update turns up; manual checks always show it. */
  const [open, setOpen] = useState(false);

  // The resolved Update handle from check(), kept so the download step can
  // act on the same object the check produced.
  const updateRef = useRef<TauriUpdate | null>(null);
  // Guard so the on-launch check fires exactly once even under StrictMode's
  // double-invoke in dev.
  const launchChecked = useRef(false);

  const runCheck = useCallback(async (manual: boolean) => {
    if (!isTauri) {
      if (manual) {
        setPhase("unsupported");
        setOpen(true);
      }
      return;
    }
    setError(null);
    setInfo(null);
    updateRef.current = null;
    if (manual) {
      setPhase("checking");
      setOpen(true);
    }
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = (await check()) as TauriUpdate | null;
      if (update) {
        updateRef.current = update;
        setInfo({ version: update.version, notes: update.body });
        setPhase("available");
        setOpen(true); // surface even for silent checks
      } else if (manual) {
        setPhase("uptodate");
        setOpen(true);
      }
      // Silent check, no update → stay hidden.
    } catch (e) {
      // A silent check that fails (offline, GitHub down) should never nag
      // the user — only surface check errors on a manual check.
      if (manual) {
        setError(String(e));
        setPhase("error");
        setOpen(true);
      }
    }
  }, []);

  // On-launch silent check, a few seconds after mount so it doesn't compete
  // with the initial connection/introspection work.
  useEffect(() => {
    if (launchChecked.current || !isTauri) return;
    launchChecked.current = true;
    const t = setTimeout(() => void runCheck(false), 3000);
    return () => clearTimeout(t);
  }, [runCheck]);

  // Manual checks from the Help menu. Skip the initial render (tick 0).
  const prevTick = useRef(manualTick);
  useEffect(() => {
    if (manualTick === prevTick.current) return;
    prevTick.current = manualTick;
    void runCheck(true);
  }, [manualTick, runCheck]);

  const download = async () => {
    const update = updateRef.current;
    if (!update) return;
    setPhase("downloading");
    setProgress(null);
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((e) => {
        switch (e.event) {
          case "Started":
            total = e.data?.contentLength ?? 0;
            setProgress(total > 0 ? 0 : null);
            break;
          case "Progress":
            downloaded += e.data?.chunkLength ?? 0;
            if (total > 0) setProgress(Math.min(1, downloaded / total));
            break;
          case "Finished":
            setProgress(1);
            break;
        }
      });
      setPhase("ready");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  const restart = async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  // Don't allow closing mid-download — the install is staging files.
  const close = () => {
    if (phase === "downloading") return;
    setOpen(false);
    setPhase("idle");
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {phase === "ready" || phase === "uptodate" ? (
            <CheckCircle2 size={14} style={{ color: "var(--ok)" }} />
          ) : phase === "error" ? (
            <AlertTriangle size={14} style={{ color: "var(--danger)" }} />
          ) : (
            <Download size={14} />
          )}
          <span>{headerFor(phase)}</span>
          <span style={{ flex: 1 }} />
          <button
            className="icon-btn"
            onClick={close}
            aria-label="Close"
            disabled={phase === "downloading"}
          >
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          {phase === "checking" && (
            <p className="muted" style={{ margin: "8px 0", display: "flex", gap: 8, alignItems: "center" }}>
              <RefreshCw size={13} className="spin" /> Checking for updates…
            </p>
          )}

          {phase === "available" && info && (
            <>
              <p style={{ margin: "4px 0" }}>
                <strong>Version {info.version}</strong> is available.
                You&apos;re on {__APP_VERSION__}.
              </p>
              {info.notes && (
                <pre className="message-pane" style={{
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  padding: 10, fontSize: 12, maxHeight: 200, overflowY: "auto",
                  marginTop: 8,
                }}>{info.notes}</pre>
              )}
            </>
          )}

          {phase === "downloading" && (
            <>
              <p style={{ margin: "8px 0" }}>Downloading update…</p>
              <div className="export-progress-bar" aria-label="download progress">
                <div
                  className={`export-progress-fill ${progress == null ? "indeterminate" : ""}`}
                  style={progress != null ? { width: `${Math.round(progress * 100)}%` } : undefined}
                />
              </div>
              {progress != null && (
                <p className="muted mono" style={{ marginTop: 8, fontSize: 11 }}>
                  {Math.round(progress * 100)}%
                </p>
              )}
            </>
          )}

          {phase === "ready" && info && (
            <p style={{ margin: "8px 0" }}>
              Version {info.version} was installed. Restart to apply it.
            </p>
          )}

          {phase === "uptodate" && (
            <p style={{ margin: "8px 0" }}>
              You&apos;re running the latest version ({__APP_VERSION__}).
            </p>
          )}

          {phase === "unsupported" && (
            <p className="muted" style={{ margin: "8px 0" }}>
              Automatic updates are only available in the desktop app.
            </p>
          )}

          {phase === "error" && (
            <pre className="message-pane err" style={{
              whiteSpace: "pre-wrap", wordBreak: "break-word",
              padding: 10, fontSize: 12, maxHeight: 200, overflowY: "auto",
            }}>{error}</pre>
          )}
        </div>

        <div className="modal-footer">
          <span style={{ flex: 1 }} />
          {phase === "available" && (
            <>
              <button className="btn-pill" onClick={close}>Later</button>
              <button className="btn-pill primary" onClick={() => void download()}>
                <Download size={12} /> Download &amp; Install
              </button>
            </>
          )}
          {phase === "downloading" && (
            <button className="btn-pill" disabled>Installing…</button>
          )}
          {phase === "ready" && (
            <>
              <button className="btn-pill" onClick={close}>Later</button>
              <button className="btn-pill primary" onClick={() => void restart()}>
                <RefreshCw size={12} /> Restart Now
              </button>
            </>
          )}
          {(phase === "uptodate" || phase === "unsupported") && (
            <button className="btn-pill primary" onClick={close}>OK</button>
          )}
          {phase === "error" && (
            <>
              <button className="btn-pill" onClick={close}>Close</button>
              <button className="btn-pill primary" onClick={() => void runCheck(true)}>Retry</button>
            </>
          )}
          {phase === "checking" && (
            <button className="btn-pill" onClick={close}>Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}

function headerFor(phase: Phase): string {
  switch (phase) {
    case "checking": return "Checking for Updates";
    case "available": return "Update Available";
    case "downloading": return "Downloading Update";
    case "ready": return "Update Ready";
    case "uptodate": return "Up to Date";
    case "unsupported": return "Updates";
    case "error": return "Update Failed";
    default: return "Updates";
  }
}
