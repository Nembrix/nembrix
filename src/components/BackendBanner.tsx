import { useEffect, useState } from "react";
import { CloudOff, Server, Database } from "lucide-react";
import { isTauri } from "@/ipc/commands";
import { probeSidecar, sidecarAvailable } from "@/ipc/sidecar";

/**
 * Visible "which backend am I talking to?" indicator.
 *
 * Three states:
 *   - Tauri        → real Rust backend, full SSH/keychain support
 *   - Sidecar      → npm run dev:sidecar is running, real Postgres
 *   - Mock         → no backend, canned data — the "why don't my tables show?" trap
 *
 * Hidden entirely in Tauri (the OS window chrome + status pill already
 * make the mode obvious). In browser dev it pins above the status bar.
 */
export default function BackendBanner() {
  const [hasSidecar, setHasSidecar] = useState(sidecarAvailable());

  useEffect(() => {
    if (isTauri) return;
    // The probe may finish after mount; re-check.
    void probeSidecar().then((ok) => setHasSidecar(ok));
  }, []);

  if (isTauri) return null;

  return hasSidecar ? (
    <div className="backend-banner sidecar" title="Connected to the Node sidecar on localhost:1421">
      <Server size={11} />
      <span>Sidecar mode</span>
      <span className="muted">— real Postgres via <code>npm run dev:sidecar</code></span>
    </div>
  ) : (
    <div className="backend-banner mock" title="No real backend — UI uses canned mock data">
      <CloudOff size={11} />
      <span>Mock mode</span>
      <span className="muted">
        — to talk to a real database, run <code>npm run dev:all</code> or <code>cargo tauri dev</code>
      </span>
      <Database size={11} className="muted" style={{ marginLeft: 4 }} />
    </div>
  );
}
