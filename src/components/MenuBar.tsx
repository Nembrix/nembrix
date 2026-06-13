import { useEffect, useRef, useState } from "react";
import { MENU, MENUS, type MenuId } from "@/menu/ids";
import { dispatchMenu } from "@/menu/dispatch";
import { isEnabled } from "@/menu/availability";
import { isTauri } from "@/ipc/commands";
import { useStore } from "@/store";
import { loadRecent } from "@/features/connections/recent";

/**
 * Browser-mode fallback menu bar. Hidden when running inside Tauri (the OS
 * menu takes over). Reactively greys disabled items based on the central
 * availability rules.
 */
export default function MenuBar() {
  const state = useStore();
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  if (isTauri) return null;

  return (
    <div className="menu-bar" ref={ref}>
      {MENUS.map((m, i) => (
        <div
          key={m.label}
          className={`menu-bar-item ${open === i ? "open" : ""}`}
          onClick={() => setOpen(open === i ? null : i)}
          onMouseEnter={() => open !== null && setOpen(i)}
        >
          {m.label}
          {open === i && (
            <div className="menu-dropdown" onClick={(e) => e.stopPropagation()}>
              {m.items.flatMap((it, j) => {
                if (it.separator) return [<div className="menu-sep" key={`s${j}`} />];
                // Special: the Recent Connections marker expands into a
                // submenu-style chunk with the top 5 recents.
                if (it.id === MENU.RECENT_CONNECTIONS_MARKER) {
                  const ids = loadRecent().slice(0, 5);
                  if (ids.length === 0) return [];
                  return [
                    <div className="menu-sep" key={`recent-top-${j}`} />,
                    <div className="menu-section" key={`recent-h-${j}`}>Recent</div>,
                    ...ids.map((cid) => {
                      const conn = state.connections.find((c) => c.id === cid);
                      const enabled = !!conn;
                      const label = conn?.name ?? "(deleted)";
                      return (
                        <div
                          key={`recent-${cid}`}
                          className={`menu-item ${enabled ? "" : "disabled"}`}
                          onClick={async () => {
                            if (!enabled) return;
                            setOpen(null);
                            await dispatchMenu(MENU.RECENT_CONNECTION_PREFIX + cid);
                          }}
                          title={conn ? `${conn.username}@${conn.host}${conn.database ? "/" + conn.database : ""}` : "Connection no longer exists"}
                        >
                          <span>{label}</span>
                        </div>
                      );
                    }),
                  ];
                }
                const enabled = it.id ? isEnabled(it.id as MenuId, state) : true;
                return [(
                  <div
                    key={it.id}
                    className={`menu-item ${enabled ? "" : "disabled"}`}
                    onClick={async () => {
                      if (!enabled) return;
                      setOpen(null);
                      if (it.id) await dispatchMenu(it.id);
                    }}
                  >
                    <span>{it.label}</span>
                    {it.accel && <span className="menu-accel">{it.accel}</span>}
                  </div>
                )];
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
