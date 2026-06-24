import { ExternalLink, X } from "lucide-react";
import { useStore } from "@/store";
import { isTauri } from "@/ipc/commands";
import NembrixMark from "@/components/NembrixMark";

/**
 * About Nembrix — version, build mode, links to repo / docs / issues.
 *
 * Renders only when the user opens it from Help → About. The version
 * comes from a vite `define` so the user always sees the version of
 * the bundle they're running, even on a hot reload after a bump.
 */
export default function AboutDialog() {
  const open = useStore((s) => s.aboutOpen);
  const close = useStore((s) => s.closeAbout);
  if (!open) return null;

  const buildMode = isTauri
    ? "Tauri desktop"
    : (window as { __SIDECAR_MODE__?: boolean }).__SIDECAR_MODE__
      ? "Sidecar (Node)"
      : "Browser (mock)";

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal about-modal"
        style={{ width: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <strong>About Nembrix</strong>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal-body about-body">
          <div className="about-hero">
            <div className="about-logo">
              <NembrixMark size={44} />
            </div>
          </div>

          <table className="about-table">
            <tbody>
              <tr><td>Version</td><td className="mono">{__APP_VERSION__}</td></tr>
              <tr><td>Build mode</td><td className="mono">{buildMode}</td></tr>
              <tr><td>Engine</td><td className="mono">Tauri 2 · React · Rust</td></tr>
            </tbody>
          </table>

          <div className="about-links">
            <a
              href="https://github.com/oesukam/nembrix"
              target="_blank" rel="noreferrer"
            >
              <ExternalLink size={11} /> Repository
            </a>
            <a
              href="https://github.com/oesukam/nembrix/blob/main/ARCHITECTURE.md"
              target="_blank" rel="noreferrer"
            >
              <ExternalLink size={11} /> Architecture
            </a>
            <a
              href="https://github.com/oesukam/nembrix/issues/new"
              target="_blank" rel="noreferrer"
            >
              <ExternalLink size={11} /> Report an issue
            </a>
          </div>
        </div>
        <div className="modal-footer">
          <div className="spacer" />
          <button className="btn-pill primary" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
