import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RefreshCw, X, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";
import { useStore } from "@/store";
import { isTauri } from "@/ipc/commands";
import NembrixMark from "@/components/NembrixMark";
import { loadPrefs, savePrefs } from "@/features/preferences/prefs";
import { setPendingInstall } from "./pendingInstall";
import { formatUpdateDate } from "./formatUpdateDate";

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
  /** Downloaded and held for the next quit ("Install on Quit"). */
  | "staged"
  | "uptodate"
  | "error"
  | "unsupported";

interface UpdateInfo {
  version: string;
  notes?: string;
  /** Publish date from the update manifest, when the server supplies one. */
  date?: string;
}

/** Minimal shape of the plugin's Update object we depend on. */
interface TauriUpdate {
  version: string;
  body?: string;
  date?: string;
  /** Download only — lets us stage a package without applying it, which is
   *  what "Install on Quit" needs. */
  download: (
    onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
  ) => Promise<void>;
  /** Apply an already-downloaded package. */
  install: () => Promise<void>;
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
  /** "Automatically download and install updates in the future". Mirrors
   *  prefs.updates.auto; written straight through on toggle so the choice
   *  survives even if the user dismisses the dialog without acting. */
  const [autoUpdate, setAutoUpdate] = useState(() => loadPrefs().updates.auto);

  // The resolved Update handle from check(), kept so the download step can
  // act on the same object the check produced.
  const updateRef = useRef<TauriUpdate | null>(null);
  // Guard so the on-launch check fires exactly once even under StrictMode's
  // double-invoke in dev.
  const launchChecked = useRef(false);

  /**
   * Fetch the update, then either apply it now or hold it for the next quit.
   *
   * `intent: "relaunch"` downloads AND installs, leaving the app ready to
   * restart. `intent: "on-quit"` downloads only and parks the handle in
   * pendingInstall — the close handler applies it as the app exits, so the
   * user isn't interrupted mid-session.
   *
   * Declared before runCheck because the auto-update path calls straight
   * into it.
   */
  const startDownload = useCallback(async (intent: "relaunch" | "on-quit") => {
    const update = updateRef.current;
    if (!update) return;
    setPhase("downloading");
    setProgress(null);
    let downloaded = 0;
    let total = 0;
    const onEvent = (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
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
    };
    try {
      if (intent === "on-quit") {
        await update.download(onEvent);
        setPendingInstall(update);
        setPhase("staged");
      } else {
        await update.downloadAndInstall(onEvent);
        setPhase("ready");
      }
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }, []);

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
        // A version the user explicitly skipped stays silent on the launch
        // check. A manual check ignores the skip — the user is asking right
        // now, so answering "nothing to see" would look broken.
        if (!manual && loadPrefs().updates.skipVersion === update.version) return;

        updateRef.current = update;
        setInfo({ version: update.version, notes: update.body, date: update.date });

        // Opted into hands-off updating: fetch and apply without prompting,
        // then surface the result. Only on the silent launch check — when the
        // user asked explicitly, show them what was found first.
        if (!manual && loadPrefs().updates.auto) {
          setOpen(true);
          void startDownload("relaunch");
          return;
        }

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
  }, [startDownload]);

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

  /** Persist the auto-update choice immediately — the user may never press
   *  a button, and the checkbox shouldn't silently forget. */
  const toggleAuto = (on: boolean) => {
    setAutoUpdate(on);
    const p = loadPrefs();
    savePrefs({ ...p, updates: { ...p.updates, auto: on } });
  };

  /** Suppress this exact version on future launch checks, then close. */
  const skipVersion = () => {
    const version = info?.version;
    if (version) {
      const p = loadPrefs();
      savePrefs({ ...p, updates: { ...p.updates, skipVersion: version } });
    }
    close();
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {phase === "ready" || phase === "uptodate" || phase === "staged" ? (
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
              <div className="update-lede">
                <NembrixMark size={40} />
                <div>
                  <p className="update-title">
                    Nembrix {info.version} is ready to install
                  </p>
                  <p className="muted update-sub">
                    You&apos;re on {__APP_VERSION__}
                    {info.date ? ` · released ${formatUpdateDate(info.date)}` : ""}
                  </p>
                </div>
              </div>
              {info.notes && (
                <pre className="message-pane" style={{
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  padding: 10, fontSize: 12, maxHeight: 200, overflowY: "auto",
                  marginTop: 8,
                }}>{info.notes}</pre>
              )}
              <div className="about-links" style={{ marginTop: 10 }}>
                <a
                  href="https://github.com/nembrix/nembrix/releases"
                  target="_blank" rel="noreferrer"
                >
                  <ExternalLink size={11} /> Older change logs
                </a>
                <a
                  href="https://github.com/nembrix/nembrix/issues/new"
                  target="_blank" rel="noreferrer"
                >
                  <ExternalLink size={11} /> Report an issue
                </a>
              </div>
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

          {phase === "staged" && info && (
            <p style={{ margin: "8px 0" }}>
              Version {info.version} was downloaded and will be installed the
              next time you quit Nembrix.
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

        {/* The auto-update opt-in belongs to the "an update exists" moment —
            showing it beside "Up to date" or an error would be noise. */}
        {(phase === "available" || phase === "staged" || phase === "ready") && (
          <label className="update-auto">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={(e) => toggleAuto(e.target.checked)}
            />
            Automatically download and install updates in the future
          </label>
        )}

        <div className="modal-footer">
          {phase === "available" && (
            <button className="btn-pill" onClick={skipVersion}>
              Skip This Version
            </button>
          )}
          <span style={{ flex: 1 }} />
          {phase === "available" && (
            <>
              <button className="btn-pill" onClick={() => void startDownload("on-quit")}>
                Install on Quit
              </button>
              <button className="btn-pill primary" onClick={() => void startDownload("relaunch")}>
                <Download size={12} /> Install &amp; Relaunch
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
          {phase === "staged" && (
            <button className="btn-pill primary" onClick={close}>Done</button>
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
    case "staged": return "Update Scheduled";
    case "uptodate": return "Up to Date";
    case "unsupported": return "Updates";
    case "error": return "Update Failed";
    default: return "Updates";
  }
}
