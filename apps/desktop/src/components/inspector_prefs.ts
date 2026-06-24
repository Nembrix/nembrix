/**
 * Persisted inspector preferences.
 *
 * Today: the collapsed/expanded state of each item group (Tables, Views,
 * Functions) keyed by connection id, so the user's preference survives
 * reload and is consistent across sessions of the same connection.
 *
 * Functions default to COLLAPSED because user-added functions tend to be
 * a small set the user only occasionally looks at — leaving them open
 * pushes the tables list down by their row count.
 */

const KEY = "nembrix.inspector.prefs.v1";

export type ItemKind = "function" | "table" | "view";

interface PerConnPrefs {
  collapsed: Partial<Record<ItemKind, boolean>>;
}

type Store = Record<string /* connectionId */, PerConnPrefs>;

const DEFAULT_COLLAPSED: Record<ItemKind, boolean> = {
  function: true,  // user-added functions only; default hidden
  table: false,
  view: false,
};

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

function save(s: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** Read the collapsed flag for a kind. Falls back to the default. */
export function isCollapsed(connectionId: string, kind: ItemKind): boolean {
  const s = load();
  const v = s[connectionId]?.collapsed?.[kind];
  return v ?? DEFAULT_COLLAPSED[kind];
}

/** Explicitly set the collapsed flag. Used after operations that
 *  add items to a group so the user actually sees the new entry —
 *  e.g. duplicating a table when the Tables group was collapsed. */
export function setCollapsed(connectionId: string, kind: ItemKind, value: boolean): void {
  const s = load();
  const conn = s[connectionId] ?? { collapsed: {} };
  conn.collapsed = { ...conn.collapsed, [kind]: value };
  s[connectionId] = conn;
  save(s);
}

/** Toggle and persist the collapsed flag. Returns the new value. */
export function toggleCollapsed(connectionId: string, kind: ItemKind): boolean {
  const s = load();
  const cur = isCollapsed(connectionId, kind);
  const next = !cur;
  const conn = s[connectionId] ?? { collapsed: {} };
  conn.collapsed = { ...conn.collapsed, [kind]: next };
  s[connectionId] = conn;
  save(s);
  return next;
}
