import { Clock, Database, Plug, Table as TableIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/store";
import * as api from "@/ipc/commands";
import type { ConnectionRecord } from "@/ipc/types";
import { loadRecent } from "@/features/connections/recent";
import { ENV_LABEL, colorFor } from "@/features/connections/environment";

/**
 * Main-area content when no tab is open.
 *
 * When a connection IS selected: a table quick-pick grid for the current
 * schema. When no connection is selected: a "Recent connections" panel so
 * the user can one-click back into something they recently used, instead
 * of having to walk into the manage-connections dialog.
 */
export default function EmptyTabArea() {
  const { selectedConnId, connections, schemas, addTab, activeSchema, openSession, setStatus, setSchema } = useStore();
  const [filter, setFilter] = useState("");

  // All hooks must run unconditionally on every render — early returns
  // below break the Rules of Hooks. Compute the table list whether or
  // not we'll end up using it; the branch comes after.
  const tree = selectedConnId ? schemas[selectedConnId] : undefined;
  const schemaName = selectedConnId
    ? (activeSchema[selectedConnId]
        ?? tree?.databases[0]?.schemas[0]?.name
        ?? "public")
    : "public";
  const sc = tree?.databases[0]?.schemas.find((s) => s.name === schemaName);
  const tables = useMemo(() => {
    const all = [...(sc?.tables ?? []), ...(sc?.views ?? [])];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all;
  }, [sc, filter]);

  /* ─── No connection selected: recents + new-connection CTA ─── */
  if (!selectedConnId) {
    return <RecentsPanel connections={connections} openSession={openSession} setStatus={setStatus} setSchema={setSchema} />;
  }

  const openTable = (name: string) => {
    addTab({
      id: crypto.randomUUID(),
      connId: selectedConnId,
      kind: "table_data",
      title: name,
      sourceRelation: { schema: schemaName, table: name },
      limit: 200,
    });
  };

  // Schema cache isn't loaded yet — connection probably introspecting.
  if (!tree) {
    return (
      <div className="placeholder">
        <span className="muted">Loading schema…</span>
      </div>
    );
  }

  return (
    <div className="empty-tab-area">
      <div className="empty-tab-hero">
        <Database size={28} strokeWidth={1.4} />
        <h3>Pick a table to open</h3>
        <p className="muted">
          Or press <span className="kbd">⌘T</span> to start with a blank query.
        </p>
        <input
          autoFocus
          className="search-input"
          placeholder="Filter tables…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginTop: 12, maxWidth: 320 }}
        />
        <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
          {schemaName} · {tables.length} table{tables.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="empty-tab-grid">
        {tables.map((t) => (
          <button
            key={t.name}
            type="button"
            className="empty-tab-card"
            onClick={() => openTable(t.name)}
            title={`Open ${schemaName}.${t.name}`}
          >
            <TableIcon size={14} />
            <span className="empty-tab-card-name">{t.name}</span>
            <span className="empty-tab-card-meta muted">
              {t.columns.length} col{t.columns.length === 1 ? "" : "s"}
            </span>
          </button>
        ))}
        {tables.length === 0 && (
          <div className="muted" style={{ padding: 24, gridColumn: "1 / -1", textAlign: "center" }}>
            {filter ? "No tables match the filter." : "This schema has no tables yet."}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The "no connection selected" landing surface. Renders the recents list
 * if there is one, with a one-click connect on each card.
 */
function RecentsPanel({
  connections,
  openSession,
  setStatus,
  setSchema,
}: {
  connections: ConnectionRecord[];
  openSession: (connId: string) => string;
  setStatus: (id: string, s: "connected" | "connecting" | "disconnected" | "error") => void;
  setSchema: (id: string, s: import("@/ipc/types").SchemaTree) => void;
}) {
  const { openConnectionForm, openConnectionManager } = useStore();
  const [recentIds, setRecentIds] = useState<string[]>(() => loadRecent());

  // Refresh from localStorage when this panel mounts so newly-bumped
  // entries (e.g. user just connected through the manager) show up.
  useEffect(() => { setRecentIds(loadRecent()); }, []);

  // Filter down to recents that still exist as saved connections. A
  // deleted connection should drop out automatically — forgetRecent()
  // handles persistence; this guards the render until that fires.
  const items = useMemo(() => {
    return recentIds
      .map((id) => connections.find((c) => c.id === id))
      .filter((c): c is ConnectionRecord => !!c);
  }, [recentIds, connections]);

  const connect = async (c: ConnectionRecord) => {
    const sessionId = openSession(c.id);
    setStatus(sessionId, "connecting");
    try {
      await api.connect(c.id);
      setStatus(sessionId, "connected");
      const tree = await api.introspect(c.id);
      setSchema(sessionId, tree);
    } catch (e) {
      setStatus(sessionId, "error");
      console.error(e);
    }
  };

  if (items.length === 0) {
    // First-run state, or all recents have been deleted.
    return (
      <div className="placeholder">
        <span className="muted">No recent connections yet.</span>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn-pill primary" onClick={() => openConnectionForm()}>
            <Plug size={12} /> New connection
          </button>
          {connections.length > 0 && (
            <button className="btn-pill" onClick={openConnectionManager}>
              Manage…
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="empty-tab-area">
      <div className="empty-tab-hero">
        <Clock size={26} strokeWidth={1.4} />
        <h3>Recent connections</h3>
        <p className="muted">One click to reconnect — your last {items.length} of 10.</p>
      </div>
      <div className="empty-tab-grid recents-grid">
        {items.map((c) => {
          const ring = colorFor(c.environment, c.color);
          return (
            <button
              key={c.id}
              type="button"
              className="empty-tab-card recents-card"
              style={{ ["--env-ring" as never]: ring }}
              onClick={() => void connect(c)}
              title={`Connect to ${c.name}`}
            >
              <Database size={14} />
              <div className="recents-card-text">
                <span className="recents-card-name">{c.name}</span>
                <span className="muted recents-card-sub">
                  {c.username}@{c.host}{c.database ? "/" + c.database : ""}
                </span>
              </div>
              {c.environment && (
                <span
                  className="rail-env"
                  style={{ background: ring, fontSize: 8.5, alignSelf: "flex-start" }}
                >
                  {ENV_LABEL[c.environment].toUpperCase()}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 8, padding: "0 24px 16px" }}>
        <button className="btn-pill primary" onClick={() => openConnectionForm()}>
          <Plug size={12} /> New connection
        </button>
        <button className="btn-pill" onClick={openConnectionManager}>
          Manage all…
        </button>
      </div>
    </div>
  );
}
