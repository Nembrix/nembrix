/**
 * Persist a tiny subset of the store to localStorage so reopening the app
 * restores open tabs, the active tab, and which connection was selected.
 *
 * Sessions are persisted too (id + underlying connectionId + label) so the
 * rail isn't empty on reload — we kick off background reconnects for each
 * one. Status and schemas are NOT persisted; they're rebuilt by the
 * reconnect handshake. Persisting a stale "connected" badge with no real
 * pool behind it would be a worse lie than showing the connecting spinner.
 */

import * as api from "@/ipc/commands";
import { useStore, type PanelState, type Tab } from "@/store";

const KEY = "nembrix.tabs.v1";

interface PersistedSession {
  id: string;
  connectionId: string;
  label?: string;
  openedAt: string;
}

interface Persisted {
  tabs: Array<Pick<Tab, "id" | "connId" | "kind" | "lang" | "title" | "sql"
    | "sourceRelation" | "filters" | "hiddenColumns" | "limit" | "sort">>;
  activeTabId: string | null;
  selectedConnId: string | null;
  sessions?: PersistedSession[];
  /** Which chrome panels are visible. Optional so pre-existing localStorage
   *  (written before panels were persisted) still hydrates. */
  panels?: Partial<PanelState>;
}

/**
 * Read persisted panel visibility, defaulting each flag to visible.
 *
 * Deliberately per-key rather than a blanket `?? DEFAULT`: a truncated or
 * hand-edited entry ({"results": false} with no other keys) should restore
 * that one flag and show the rest, not fall back to all-visible and silently
 * discard the user's layout. Non-boolean values are ignored the same way, so
 * corrupt state can never leave a pane stuck hidden.
 */
function readPanels(p: Partial<PanelState> | undefined): PanelState {
  const pick = (v: unknown) => (typeof v === "boolean" ? v : true);
  return {
    rail: pick(p?.rail),
    inspector: pick(p?.inspector),
    results: pick(p?.results),
  };
}

export function hydrateTabsFromStorage() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Persisted;
    if (!p || !Array.isArray(p.tabs)) return;
    // Rehydrate sessions with their original ids so tabs that reference
    // them via `connId` keep working without rewriting.
    const sessions = (p.sessions ?? []).map((s) => ({
      id: s.id,
      connectionId: s.connectionId,
      label: s.label,
      openedAt: s.openedAt,
    }));
    const sessionIds = new Set(sessions.map((s) => s.id));
    // Drop any tabs that point at a session we no longer have. Otherwise
    // we end up with "ghost" tabs whose connection is gone — the user
    // reported this as "the connection disappears but the tables stay."
    // Legacy localStorage (pre-sessions refactor) had tabs whose connId
    // was a connection id directly; we keep those when their connection
    // still exists so the user doesn't lose work on first migration.
    const tabs = p.tabs.filter((t) => sessionIds.size === 0 || sessionIds.has(t.connId));
    useStore.setState({
      tabs: tabs.map((t) => ({ ...t } as Tab)),
      activeTabId: p.activeTabId && tabs.some((t) => t.id === p.activeTabId)
        ? p.activeTabId
        : null,
      selectedConnId: p.selectedConnId && (sessionIds.size === 0 || sessionIds.has(p.selectedConnId))
        ? p.selectedConnId
        : null,
      sessions,
      panels: readPanels(p.panels),
    });
    // Kick off background reconnects so the rail's avatars flip from
    // grey → connecting → connected without the user having to click.
    if (p.sessions && p.sessions.length > 0) {
      void reconnectAll(p.sessions);
    }
  } catch { /* corrupted state → ignore */ }
}

/**
 * Re-establish each persisted session against its underlying saved
 * connection. We need the connections list to be present first (the
 * mock backend reads from localStorage, the Tauri/sidecar backends
 * read from the keychain/SQLite/sidecar map). We give it a short window
 * to arrive — App.tsx fires `api.listConnections()` very early.
 */
async function reconnectAll(sessions: PersistedSession[]): Promise<void> {
  // Load connections directly here rather than waiting for the rail to
  // mount and do it — previous version depended on a sibling component's
  // mount cycle, which is fragile (rail can be toggled off; HMR can race;
  // hot reload reorders mount). Failing to find connections used to
  // *close* the persisted sessions, which is exactly the "disconnects on
  // refresh" bug the user reported.
  try {
    const list = await api.listConnections();
    useStore.getState().setConnections(list);
  } catch (e) {
    // If we can't list connections we have no hope of reconnecting. Leave
    // the sessions in the rail as "error" rather than closing them — the
    // user can click to retry once the backend is reachable.
    console.warn("[session-resume] listConnections failed:", e);
    for (const sess of sessions) {
      useStore.getState().setStatus(sess.id, "error");
    }
    return;
  }

  const knownConnIds = new Set(useStore.getState().connections.map((c) => c.id));

  for (const sess of sessions) {
    if (!knownConnIds.has(sess.connectionId)) {
      // Underlying saved connection truly doesn't exist anymore (deleted
      // between sessions). Only NOW is it safe to close the persisted
      // session — anything else just shows an error state.
      useStore.getState().closeSession(sess.id);
      continue;
    }
    useStore.getState().setStatus(sess.id, "connecting");
    try {
      await api.connect(sess.connectionId);
      useStore.getState().setStatus(sess.id, "connected");
      const tree = await api.introspect(sess.connectionId);
      useStore.getState().setSchema(sess.id, tree);
    } catch (e) {
      useStore.getState().setStatus(sess.id, "error");
      console.warn(`[session-resume] ${sess.connectionId} failed:`, e);
    }
  }
}

export function startTabsPersistence() {
  let last = "";
  useStore.subscribe((s) => {
    const snapshot: Persisted = {
      tabs: s.tabs.map((t) => ({
        id: t.id,
        connId: t.connId,
        kind: t.kind,
        lang: t.lang, // SQL vs JavaScript scripting — must survive a refresh
        title: t.title,
        sql: t.sql,
        sourceRelation: t.sourceRelation,
        filters: t.filters,
        hiddenColumns: t.hiddenColumns,
        limit: t.limit,
        sort: t.sort,
      })),
      activeTabId: s.activeTabId,
      selectedConnId: s.selectedConnId,
      panels: s.panels,
      sessions: s.sessions.map((sess) => ({
        id: sess.id,
        connectionId: sess.connectionId,
        label: sess.label,
        openedAt: sess.openedAt,
      })),
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === last) return;
    last = serialized;
    try { localStorage.setItem(KEY, serialized); } catch { /* ignore */ }
  });
}
