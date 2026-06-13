import { X } from "lucide-react";
import { MENUS } from "@/menu/ids";
import { useStore } from "@/store";

export default function ShortcutsModal() {
  const { shortcutsOpen, closeShortcuts } = useStore();
  if (!shortcutsOpen) return null;
  return (
    <div className="modal-backdrop" onClick={closeShortcuts}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Keyboard shortcuts</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={closeShortcuts}><X size={14} /></button>
        </div>
        <div className="modal-body">
          {MENUS.map((m) => {
            const rows = m.items.filter((i) => !i.separator && i.accel);
            if (!rows.length) return null;
            return (
              <div key={m.label} style={{ marginBottom: 12 }}>
                <div className="section-title" style={{ borderTop: 0, paddingTop: 0, marginTop: 0 }}>
                  {m.label}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {rows.map((it) => (
                      <tr key={it.id}>
                        <td style={{ padding: "3px 6px", color: "var(--fg-2)" }}>{it.label}</td>
                        <td style={{ padding: "3px 6px", textAlign: "right" }}>
                          <span className="kbd">{it.accel}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
        <div className="modal-footer">
          <span className="muted">From the OS menu bar, or right-click items in the inspector and rail.</span>
          <span style={{ flex: 1 }} />
          <button className="btn-pill primary" onClick={closeShortcuts}>Close</button>
        </div>
      </div>
    </div>
  );
}
