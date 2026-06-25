import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RefreshCcw, XCircle } from "lucide-react";
import type { Tab } from "@/store";
import * as api from "@/ipc/commands";
import type { CellValue, RowBatch } from "@/ipc/types";

/**
 * Postgres activity surface: live sessions from pg_stat_activity + a small
 * server overview card. Auto-refreshes on a user-configurable interval; the
 * fetch uses execute+stream rather than the data-view path so it can never
 * touch the user's main query slot.
 */
const SESSIONS_SQL = `
SELECT pid, datname, usename, application_name, client_addr::text AS client_addr,
       state, wait_event_type, wait_event,
       backend_start, xact_start, query_start, state_change,
       query
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
ORDER BY backend_start DESC
LIMIT 200;
`.trim();

const OVERVIEW_SQL = `
SELECT
  (SELECT count(*) FROM pg_stat_activity)                        AS sessions,
  (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS max_conn,
  (SELECT setting::int FROM pg_settings WHERE name='server_version_num') AS server_version,
  (SELECT round(sum(xact_commit + xact_rollback)::numeric, 0)
     FROM pg_stat_database)                                       AS txns_total,
  (SELECT round(sum(blks_hit)::numeric / NULLIF(sum(blks_hit + blks_read), 0)::numeric * 100, 2)
     FROM pg_stat_database)                                       AS cache_hit_pct,
  (SELECT round(sum(deadlocks)::numeric, 0) FROM pg_stat_database) AS deadlocks;
`.trim();

interface Session {
  pid: number;
  datname?: string;
  usename?: string;
  application_name?: string;
  client_addr?: string;
  state?: string;
  wait_event_type?: string;
  wait_event?: string;
  query?: string;
  backend_start?: string;
  query_start?: string;
}

interface Overview {
  sessions: number;
  max_conn: number;
  txns_total?: number;
  cache_hit_pct?: number;
  deadlocks?: number;
}

const INTERVALS = [
  { label: "Off", ms: 0 },
  { label: "1s", ms: 1000 },
  { label: "2s", ms: 2000 },
  { label: "5s", ms: 5000 },
  { label: "10s", ms: 10000 },
];

export default function ActivityTab({ tab }: { tab: Tab }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [intervalMs, setIntervalMs] = useState(2000);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const refresh = useRef<() => void>(() => {});

  // Fetch routine — uses stream(), drains the single mock-or-real batch.
  // Stored in a ref so the interval and event handlers always invoke the
  // freshest closure (which captures the current tab.connId). Assigned in
  // an effect rather than the render body so the ref is never written
  // during render.
  useEffect(() => {
    refresh.current = async () => {
      try {
        const sessionsRows = await fetchRows(tab.connId, SESSIONS_SQL);
        setSessions(sessionsRows.map(rowToSession));
        const ov = await fetchRows(tab.connId, OVERVIEW_SQL);
        if (ov[0]) setOverview(rowToOverview(ov[0]));
        setErr(null);
      } catch (e) {
        setErr(String(e));
      }
    };
  });

  // Initial + interval.
  useEffect(() => {
    refresh.current();
    if (!intervalMs) return;
    const id = window.setInterval(() => refresh.current(), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, tab.connId]);

  const filtered = useMemo(() => {
    if (!filter) return sessions;
    const f = filter.toLowerCase();
    return sessions.filter((s) =>
      [s.usename, s.application_name, s.client_addr, s.state, s.wait_event, s.query]
        .filter(Boolean).some((v) => (v ?? "").toLowerCase().includes(f)));
  }, [sessions, filter]);

  const cancelQuery = async (pid: number) => {
    try { await api.execute(tab.connId, `SELECT pg_cancel_backend(${pid});`); }
    catch (e) { setErr(String(e)); }
    refresh.current();
  };
  const terminate = async (pid: number) => {
    if (!confirm(`Terminate backend ${pid}? Any in-flight transaction will be rolled back.`)) return;
    try { await api.execute(tab.connId, `SELECT pg_terminate_backend(${pid});`); }
    catch (e) { setErr(String(e)); }
    refresh.current();
  };

  return (
    <div className="editor-shell">
      <div className="data-view-toolbar">
        <strong>Activity</strong>
        {overview && (
          <span className="muted">
            · {overview.sessions}/{overview.max_conn} sessions
            {overview.cache_hit_pct != null && ` · ${overview.cache_hit_pct}% cache hit`}
            {overview.deadlocks != null && overview.deadlocks > 0 && ` · ${overview.deadlocks} deadlocks`}
          </span>
        )}
        <div className="spacer" />
        <input
          className="search-input"
          style={{ width: 200, paddingLeft: 8 }}
          placeholder="Filter sessions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="muted">Refresh</label>
        <select value={intervalMs} onChange={(e) => setIntervalMs(parseInt(e.target.value))}>
          {INTERVALS.map((i) => <option key={i.label} value={i.ms}>{i.label}</option>)}
        </select>
        <button className="btn-pill" onClick={() => refresh.current()}>
          <RefreshCcw size={12} /> Now
        </button>
        <button className="btn-pill" onClick={() => setIntervalMs(intervalMs ? 0 : 2000)}>
          {intervalMs ? <><Pause size={12} /> Pause</> : <><Play size={12} /> Resume</>}
        </button>
      </div>

      {err && <div className="message-pane err" style={{ padding: 10 }}>{err}</div>}

      <div className="result-body" style={{ overflow: "auto" }}>
        <table className="meta-table sessions-table">
          <thead><tr>
            <th>PID</th><th>User</th><th>DB</th><th>App</th><th>State</th>
            <th>Wait</th><th>Query</th><th></th>
          </tr></thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="muted" style={{ textAlign: "center", padding: 20 }}>
                No matching sessions.
              </td></tr>
            )}
            {filtered.map((s) => (
              <tr key={s.pid} className={s.state === "active" ? "row-active" : ""}>
                <td className="mono">{s.pid}</td>
                <td>{s.usename ?? "—"}</td>
                <td>{s.datname ?? "—"}</td>
                <td className="muted">{s.application_name ?? "—"}</td>
                <td>
                  <span className={`state-pill state-${(s.state ?? "idle").replace(/\s+/g, "-")}`}>
                    {s.state ?? "idle"}
                  </span>
                </td>
                <td className="muted">{s.wait_event_type ? `${s.wait_event_type}/${s.wait_event}` : "—"}</td>
                <td className="mono session-sql" title={s.query}>
                  {(s.query ?? "").replace(/\s+/g, " ").slice(0, 120)}
                </td>
                <td>
                  <button className="icon-btn" title="Cancel query" onClick={() => cancelQuery(s.pid)}>
                    <XCircle size={11} />
                  </button>
                  <button className="icon-btn danger" title="Terminate session" onClick={() => terminate(s.pid)}>
                    <XCircle size={11} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function fetchRows(connId: string, sql: string): Promise<Array<Record<string, string>>> {
  return await new Promise((resolve, reject) => {
    const accum: RowBatch[] = [];
    let columns: { name: string }[] = [];
    api.stream(connId, sql, (b) => {
      if (b.columns) columns = b.columns;
      accum.push(b);
      if (b.done) {
        const rows = accum.flatMap((bb) => bb.rows);
        resolve(rows.map((r) => {
          const o: Record<string, string> = {};
          columns.forEach((c, i) => {
            o[c.name] = cellToString(r[i]);
          });
          return o;
        }));
      }
    }).catch(reject);
  });
}

function cellToString(v: CellValue): string {
  switch (v.kind) {
    case "null": return "";
    case "bool": return v.value ? "true" : "false";
    case "int":
    case "float": return String(v.value);
    case "text":
    case "raw": return v.value;
    case "document": return JSON.stringify(v.value);
    case "bytes": return `<${v.value.length}b>`;
  }
}

function rowToSession(r: Record<string, string>): Session {
  return {
    pid: parseInt(r.pid),
    datname: r.datname,
    usename: r.usename,
    application_name: r.application_name,
    client_addr: r.client_addr,
    state: r.state,
    wait_event_type: r.wait_event_type,
    wait_event: r.wait_event,
    query: r.query,
    backend_start: r.backend_start,
    query_start: r.query_start,
  };
}
function rowToOverview(r: Record<string, string>): Overview {
  return {
    sessions: parseInt(r.sessions),
    max_conn: parseInt(r.max_conn),
    txns_total: r.txns_total ? parseInt(r.txns_total) : undefined,
    cache_hit_pct: r.cache_hit_pct ? parseFloat(r.cache_hit_pct) : undefined,
    deadlocks: r.deadlocks ? parseInt(r.deadlocks) : undefined,
  };
}
