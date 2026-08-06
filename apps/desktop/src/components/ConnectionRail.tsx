import { useEffect, useState } from "react";
import { Database, ListTree, Plus } from "lucide-react";
import { useStore } from "@/store";
import * as api from "@/ipc/commands";
import ContextMenu, { type ContextItem } from "@/components/ContextMenu";
import Tooltip from "@/components/Tooltip";
import { dispatchMenu } from "@/menu/dispatch";
import { MENU } from "@/menu/ids";
import { ENV_LABEL, colorFor } from "@/features/connections/environment";

/**
 * Connect a session to its underlying saved connection. The session id is
 * what the rest of the app keys against; the underlying api.connect()
 * takes a saved-connection id, so we resolve via the sessions table.
 */
async function connectSessionAndIntrospect(sessionId: string) {
  const s = useStore.getState();
  if (s.status[sessionId] === "connected") return;
  const session = s.sessions.find((sess) => sess.id === sessionId);
  if (!session) return;
  s.setStatus(sessionId, "connecting");
  try {
    await api.connect(session.connectionId);
    s.setStatus(sessionId, "connected");
    const tree = await api.introspect(session.connectionId);
    s.setSchema(sessionId, tree);
  } catch {
    s.setStatus(sessionId, "error");
  }
}

export default function ConnectionRail({ onNewConnection }: { onNewConnection: () => void }) {
  const {
    connections, setConnections, sessions, status, selectedConnId,
    selectConn, closeSession, openConnectionManager,
  } = useStore();
  const [ctx, setCtx] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);

  useEffect(() => {
    api.listConnections().then(setConnections);
  }, [setConnections]);

  const onSessionContextMenu = (e: React.MouseEvent, sessionId: string, connectionId: string) => {
    e.preventDefault();
    selectConn(sessionId);
    const otherCount = useStore.getState().sessions.filter((s) => s.id !== sessionId).length;
    const items: ContextItem[] = [
      { label: "Refresh schema", onClick: () => dispatchMenu(MENU.REFRESH_SCHEMA) },
      { label: "Open another session",
        onClick: () => {
          const newId = useStore.getState().openSession(connectionId);
          void connectSessionAndIntrospect(newId);
        } },
      { label: "Edit connection…", onClick: () => dispatchMenu(MENU.EDIT_CONNECTION) },
      { separator: true },
      // Rail rows are always-connected sessions (like tabs). "Close" tears the
      // session down — disconnect the backend pool, then drop it from the rail.
      { label: "Close connection", danger: true, onClick: () => void closeSessionFully(sessionId) },
      ...(otherCount > 0
        ? [{ label: "Close other connections", danger: true, onClick: () => void closeOtherSessions(sessionId) }]
        : []),
    ];
    setCtx({ x: e.clientX, y: e.clientY, items });
  };

  /** Fully close a session: disconnect the backend pool, then remove it from
   *  the rail. `closeSession` alone only cleared the store, leaking the pool. */
  const closeSessionFully = async (sessionId: string) => {
    try { await api.disconnect(sessionId); } catch { /* best-effort */ }
    closeSession(sessionId);
  };

  /** Close every session except the given one. */
  const closeOtherSessions = async (keepId: string) => {
    const others = useStore.getState().sessions.filter((s) => s.id !== keepId).map((s) => s.id);
    await Promise.all(others.map(async (id) => {
      try { await api.disconnect(id); } catch { /* best-effort */ }
      closeSession(id);
    }));
  };

  return (
    <aside className="rail">
      <div className="rail-list">
      {sessions.length === 0 && (
        <div className="rail-empty muted" title="No live sessions">
          <Database size={20} strokeWidth={1.5} />
        </div>
      )}
      {sessions.map((sess) => {
        // The full connection record loads asynchronously via
        // `listConnections`. While it's in flight, DON'T drop the session's
        // avatar (that made the rail flash empty on boot and was the root of
        // the intermittent ".rail-avatar not found" e2e flake) — render a
        // lightweight placeholder from what the session already knows, and
        // enrich it once the record arrives.
        const loaded = connections.find((cn) => cn.id === sess.connectionId);
        const c = loaded ?? {
          id: sess.connectionId,
          name: sess.label ?? "Connection",
          engine: "postgres",
          host: "",
          port: 0,
          username: "",
          database: undefined,
          ssl_mode: "prefer",
          ssh: null,
          color: null,
          environment: undefined,
        } as unknown as (typeof connections)[number];
        const st = status[sess.id] ?? "disconnected";
        const active = selectedConnId === sess.id;
        const db = c.database ?? "—";
        const summary = `${c.username}@${c.host}:${c.port}${c.database ? "/" + c.database : ""}`;
        const envLabel = c.environment ? ENV_LABEL[c.environment] : "";
        const ring = colorFor(c.environment, c.color);
        const displayName = sess.label ? `${c.name} ${sess.label}` : c.name;
        const tip = st === "connected"
          ? `${displayName}${envLabel ? ` · ${envLabel}` : ""} — connected · ${summary}`
          : `${displayName}${envLabel ? ` · ${envLabel}` : ""} — ${summary}`;
        const isProd = c.environment === "production";
        return (
          <Tooltip key={sess.id} label={tip} side="bottom">
            <div
              className={`rail-entry ${active ? "active" : ""} ${isProd ? "is-prod" : ""}`}
              // The rail row IS the connect affordance now (clicking it connects
              // a dropped session). These carry the live status so tests can wait
              // deterministically for "connected" — same contract the old
              // separate connect button exposed.
              data-testid="connect-btn"
              data-state={st}
              // Click selects/switches to this connection's view AND silently
              // reconnects it if the session has dropped — the rail is meant to
              // be "always connected", so switching back to a stale session
              // should recover it, not surface "not connected". Already-live
              // sessions just select. Tearing a session down is an explicit
              // right-click → "Close connection".
              onClick={() => {
                selectConn(sess.id);
                if (st !== "connected" && st !== "connecting") {
                  void connectSessionAndIntrospect(sess.id);
                }
              }}
              onContextMenu={(e) => onSessionContextMenu(e, sess.id, sess.connectionId)}
              style={{ ["--env-ring" as never]: ring }}
            >
              <div className={`rail-avatar ${st}`}>
                <Database size={18} strokeWidth={1.75} />
                <span className="badge" />
                {/* The avatar covers the whole tile. A plain click just
                    selects/switches (handled by the row's onClick, which this
                    doesn't stopPropagation). The status dot shows connection
                    health; closing a connection is done via right-click →
                    "Close connection" so it isn't a one-pixel-off accident. */}
              </div>
              <span className="rail-name">{displayName}</span>
              <span className="rail-db">{db}</span>
              {c.environment && (
                <span className="rail-env" style={{ background: ring }}>
                  {ENV_LABEL[c.environment].toUpperCase()}
                </span>
              )}
            </div>
          </Tooltip>
        );
      })}
      </div>
      {/* Bottom action row sits outside the scrollable list so it stays
          anchored to the bottom even when there are many sessions. */}
      <div className="rail-actions">
        <Tooltip label="New connection" shortcut="⌘N" side="top">
          <div className="rail-add" onClick={onNewConnection}>
            <Plus size={18} strokeWidth={2} />
          </div>
        </Tooltip>
        <Tooltip label="Manage connections" shortcut="⌘⇧L" side="top">
          <div className="rail-add" onClick={openConnectionManager} data-testid="rail-manage">
            <ListTree size={16} strokeWidth={2} />
          </div>
        </Tooltip>
      </div>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </aside>
  );
}
