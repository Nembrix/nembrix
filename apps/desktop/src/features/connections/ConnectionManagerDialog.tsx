import { useMemo, useState } from "react";
import {
  CheckCircle2, ChevronDown, ChevronRight, Database, Edit3, Filter, FolderPlus,
  Play, Plus, Search, Trash2, X,
} from "lucide-react";
import { useStore } from "@/store";
import * as api from "@/ipc/commands";
import type { ConnectionRecord, Environment } from "@/ipc/types";
import { ENV_LABEL, ENVIRONMENTS, colorFor } from "./environment";
import {
  addEmptyGroup, compareOrder, load as loadGroups, removeEmptyGroup, reorder,
} from "./groups";
import { forgetRecent } from "./recent";

type StatusFilter = "all" | "connected" | "disconnected";
type EnvFilter   = "all" | Environment;

/**
 * The connection manager dialog.
 *
 * Lists every saved connection with search and filters. From here you
 * can connect (opens a new session on the rail), open another session
 * for an already-connected connection (this is the "multiple sessions
 * per connection" requirement), edit, delete, or create a new one.
 *
 * Crucially, this dialog never replaces an existing session — every
 * Connect click is additive. Closing a rail entry is the only way to
 * tear a session down.
 */
export default function ConnectionManagerDialog({ onClose }: { onClose: () => void }) {
  const { connections, sessions, status, openSession, openConnectionForm } = useStore();
  const [query, setQuery] = useState("");
  const [envFilter, setEnvFilter] = useState<EnvFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => setCollapsedGroups((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  /* Tick to re-render after localStorage-backed group state changes. We
   * deliberately avoid a separate store slice for groups since they're
   * UI-only — the dialog is the only consumer. */
  const [groupsTick, setGroupsTick] = useState(0);
  // groupsTick is an intentional manual re-fetch trigger: loadGroups()
  // reads localStorage (non-reactive), and bumpGroups() forces a re-read
  // after we mutate group state. The dep is deliberate, not redundant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groupsState = useMemo(() => loadGroups(), [groupsTick]);
  const bumpGroups = () => setGroupsTick((t) => t + 1);

  /* Drag-and-drop transient state — which row is mid-drag, and which
   * row/group is currently the drop target. Both clear on drop/end. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<{ kind: "row" | "group"; id: string } | null>(null);

  // Number of live sessions per connection id — used for the "Open
  // another session" affordance.
  const sessionCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const sess of sessions) {
      m.set(sess.connectionId, (m.get(sess.connectionId) ?? 0) + 1);
      // Count only as "connected" if there's an actually-connected session.
    }
    return m;
  }, [sessions]);

  const liveConnIds = useMemo(() => {
    // A connection counts as "currently connected" if it has at least one
    // session whose status is "connected".
    const set = new Set<string>();
    for (const sess of sessions) {
      if (status[sess.id] === "connected") set.add(sess.connectionId);
    }
    return set;
  }, [sessions, status]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return connections.filter((c) => {
      if (envFilter !== "all" && (c.environment ?? "other") !== envFilter) return false;
      if (statusFilter === "connected" && !liveConnIds.has(c.id)) return false;
      if (statusFilter === "disconnected" && liveConnIds.has(c.id)) return false;
      if (!q) return true;
      const haystack = [
        c.name, c.host, c.username, c.database ?? "",
        c.environment ?? "", ENV_LABEL[c.environment ?? "other"],
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [connections, query, envFilter, statusFilter, liveConnIds]);

  const connectNow = async (c: ConnectionRecord) => {
    const id = openSession(c.id);
    useStore.getState().setStatus(id, "connecting");
    try {
      await api.connect(c.id);
      useStore.getState().setStatus(id, "connected");
      const tree = await api.introspect(c.id);
      useStore.getState().setSchema(id, tree);
      onClose();
    } catch (e) {
      useStore.getState().setStatus(id, "error");
      console.error(e);
    }
  };

  /**
   * Bucket the filtered list by group name. Empty groups (created by the
   * user but with no connections yet) get included as empty buckets so
   * they remain a visible drop target. Within each group, connections
   * sort by their persisted order index, falling back to alphabetical.
   * "Ungrouped" lands last so named groups always read top-down.
   */
  const grouped = useMemo(() => {
    const buckets = new Map<string, ConnectionRecord[]>();
    for (const c of filtered) {
      const key = c.group?.trim() || "Ungrouped";
      const list = buckets.get(key);
      if (list) list.push(c);
      else buckets.set(key, [c]);
    }
    // Surface empty groups as drop targets. We only do this when the user
    // hasn't typed a search query — otherwise the empty bucket reads as
    // a confusing "ghost group".
    if (!query.trim()) {
      for (const g of groupsState.empty) {
        if (!buckets.has(g)) buckets.set(g, []);
      }
    }
    // Sort each bucket using the persisted order, then by name.
    const nameOf = (id: string) => connections.find((x) => x.id === id)?.name ?? "";
    const cmp = compareOrder(groupsState.order, nameOf);
    for (const list of buckets.values()) {
      list.sort((a, b) => cmp(a.id, b.id));
    }
    const entries = Array.from(buckets.entries());
    entries.sort(([a], [b]) => {
      if (a === "Ungrouped") return 1;
      if (b === "Ungrouped") return -1;
      return a.localeCompare(b);
    });
    return entries;
  }, [filtered, groupsState, connections, query]);

  /**
   * Persist a group change to the backend. We rebuild the input shape
   * from the saved record, leaving password null so existing secrets are
   * preserved. SSH credentials likewise round-trip via key_path; passing
   * password/passphrase null is a no-op for keychain entries.
   */
  const patchGroup = async (c: ConnectionRecord, nextGroup: string | null) => {
    await api.saveConnection({
      id: c.id,
      name: c.name,
      engine: "postgres",
      host: c.host,
      port: c.port,
      username: c.username,
      password: null,
      database: c.database,
      ssl_mode: c.ssl_mode as "disable" | "prefer" | "require",
      ssh: c.ssh ? {
        host: c.ssh.host,
        port: c.ssh.port,
        user: c.ssh.user,
        auth_kind: c.ssh.auth_kind as "password" | "key_file" | "agent",
        password: null,
        key_path: c.ssh.key_path,
        key_data: null,
        key_passphrase: null,
        strict_host_key: c.ssh.strict_host_key,
      } : null,
      color: c.color,
      environment: c.environment,
      group: nextGroup,
    });
    useStore.getState().setConnections(await api.listConnections());
  };

  const newGroup = () => {
    const name = prompt("New group name");
    if (!name?.trim()) return;
    addEmptyGroup(name.trim());
    bumpGroups();
  };

  /* ─── Drag and drop ─── */

  const onRowDragStart = (e: React.DragEvent, c: ConnectionRecord) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/dbclient-conn", c.id);
    setDraggingId(c.id);
  };
  const onRowDragOver = (e: React.DragEvent, c: ConnectionRecord) => {
    if (!draggingId || draggingId === c.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropOn({ kind: "row", id: c.id });
  };
  const onRowDrop = async (e: React.DragEvent, target: ConnectionRecord) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/dbclient-conn");
    setDraggingId(null);
    setDropOn(null);
    if (!id || id === target.id) return;
    const moving = connections.find((c) => c.id === id);
    if (!moving) return;
    const targetGroup = target.group?.trim() || "Ungrouped";
    const movingGroup = moving.group?.trim() || "Ungrouped";
    // Cross-group drag → change the connection's group first. Then reorder
    // within the (potentially new) target group.
    if (targetGroup !== movingGroup) {
      await patchGroup(moving, targetGroup === "Ungrouped" ? null : targetGroup);
    }
    const groupRows = grouped.find(([g]) => g === targetGroup)?.[1] ?? [];
    const groupIds = groupRows.map((r) => r.id);
    // When coming from another group, moving.id isn't in groupIds yet —
    // reorder() handles that by appending then re-densifying.
    if (!groupIds.includes(moving.id)) groupIds.push(moving.id);
    reorder(moving.id, targetGroup, target.id, groupIds);
    bumpGroups();
  };
  const onGroupDragOver = (e: React.DragEvent, groupName: string) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropOn({ kind: "group", id: groupName });
  };
  const onGroupDrop = async (e: React.DragEvent, groupName: string) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/dbclient-conn");
    setDraggingId(null);
    setDropOn(null);
    if (!id) return;
    const moving = connections.find((c) => c.id === id);
    if (!moving) return;
    const currentGroup = moving.group?.trim() || "Ungrouped";
    if (currentGroup === groupName) return;
    // Move into the group at the end (no target row).
    await patchGroup(moving, groupName === "Ungrouped" ? null : groupName);
    // If we just emptied the group's empty-list entry, remove it.
    if (currentGroup !== "Ungrouped") removeEmptyGroup(currentGroup);
    bumpGroups();
  };
  const onDragEnd = () => { setDraggingId(null); setDropOn(null); };

  const remove = async (c: ConnectionRecord) => {
    if (!confirm(`Delete saved connection "${c.name}"? Live sessions stay open until disconnected.`)) return;
    await api.deleteConnection(c.id);
    forgetRecent(c.id);
    useStore.getState().setConnections(await api.listConnections());
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal connection-manager" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Database size={14} />
          <span>Connections</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="connection-manager-toolbar">
          <div className="search-wrap" style={{ flex: 1 }}>
            <Search size={13} />
            <input
              className="search-input"
              autoFocus
              placeholder="Search by name, host, user, database…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="cm-search"
            />
          </div>
          <select
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value as EnvFilter)}
            data-testid="cm-env-filter"
            title="Filter by environment"
          >
            <option value="all">All environments</option>
            {ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>{ENV_LABEL[env]}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            data-testid="cm-status-filter"
            title="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="connected">Connected</option>
            <option value="disconnected">Not connected</option>
          </select>
          <button
            className="btn-pill"
            onClick={newGroup}
            title="Create an empty group you can then drag connections into"
            data-testid="cm-new-group"
          >
            <FolderPlus size={12} /> New group
          </button>
          <button className="btn-pill primary" onClick={() => {
            onClose();
            openConnectionForm();
          }}>
            <Plus size={12} /> New
          </button>
        </div>

        <div className="connection-manager-list">
          {filtered.length === 0 && (
            <div className="placeholder muted">
              <Filter size={18} />
              <span>No connections match.</span>
            </div>
          )}
          {grouped.map(([groupName, list]) => {
            const collapsed = collapsedGroups.has(groupName);
            const liveInGroup = list.filter((c) => liveConnIds.has(c.id)).length;
            return (
              <div
                key={groupName}
                className={`cm-group ${dropOn?.kind === "group" && dropOn.id === groupName ? "drop-target" : ""}`}
                onDragOver={(e) => onGroupDragOver(e, groupName)}
                onDrop={(e) => onGroupDrop(e, groupName)}
                onDragLeave={() => setDropOn((d) => d?.kind === "group" && d.id === groupName ? null : d)}
              >
                <button
                  type="button"
                  className="cm-group-header"
                  onClick={() => toggleGroup(groupName)}
                  data-testid="cm-group-header"
                >
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span className="cm-group-name">{groupName}</span>
                  <span className="cm-group-count muted">
                    {list.length}{liveInGroup > 0 ? ` · ${liveInGroup} live` : ""}
                    {list.length === 0 ? " · empty" : ""}
                  </span>
                </button>
                {!collapsed && (
                  <div className="cm-group-rows">
                    {list.map((c) => {
                      const ring = colorFor(c.environment, c.color);
                      const liveCount = sessionCounts.get(c.id) ?? 0;
                      const isLive = liveConnIds.has(c.id);
                      return (
              <div
                key={c.id}
                className={[
                  "cm-row",
                  isLive ? "is-live" : "",
                  draggingId === c.id ? "is-dragging" : "",
                  dropOn?.kind === "row" && dropOn.id === c.id ? "drop-above" : "",
                ].filter(Boolean).join(" ")}
                style={{ ["--env-ring" as never]: ring }}
                data-testid="cm-row"
                draggable
                onDragStart={(e) => onRowDragStart(e, c)}
                onDragOver={(e) => onRowDragOver(e, c)}
                onDrop={(e) => void onRowDrop(e, c)}
                onDragEnd={onDragEnd}
                onDoubleClick={() => void connectNow(c)}
                title="Drag to reorder · double-click to connect"
              >
                <div className="cm-avatar" title={c.environment ? ENV_LABEL[c.environment] : ""}>
                  <Database size={16} strokeWidth={1.75} />
                </div>
                <div className="cm-row-text">
                  <div className="cm-row-title">
                    <strong>{c.name}</strong>
                    {c.environment && (
                      <span className="rail-env" style={{ background: ring, fontSize: 8.5 }}>
                        {ENV_LABEL[c.environment].toUpperCase()}
                      </span>
                    )}
                    {isLive && (
                      <span className="cm-live-pill">
                        <CheckCircle2 size={10} /> {liveCount} live
                      </span>
                    )}
                  </div>
                  <div className="cm-row-summary muted">
                    {c.username}@{c.host}:{c.port}{c.database ? "/" + c.database : ""}
                  </div>
                </div>
                <div className="cm-row-actions">
                  <button
                    className="btn-pill"
                    onClick={() => connectNow(c)}
                    data-testid="cm-connect"
                    title={liveCount > 0
                      ? "Open an additional, independent session to this connection"
                      : "Connect to this database"}
                  >
                    {/* "New session" (not "Connect again", which read like a
                        retry) — it opens ANOTHER live session to the same
                        connection so you can run queries in parallel. */}
                    <Play size={11} /> {liveCount > 0 ? "New session" : "Connect"}
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => { onClose(); useStore.getState().openConnectionForm(c.id); }}
                    title="Edit"
                  >
                    <Edit3 size={13} />
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={() => remove(c)}
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="modal-footer">
          <span className="muted">{filtered.length} of {connections.length} connection{connections.length === 1 ? "" : "s"}</span>
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
