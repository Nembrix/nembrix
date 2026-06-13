/**
 * Per-(connection, schema, table) column width overrides.
 * Persisted in localStorage so a width set today survives a reload.
 *
 * Bare query tabs (no sourceRelation) use a synthetic key `__query:<tabId>`
 * so resizes still stick during the session but don't pollute the saved
 * map across reloads.
 */

const KEY = "nembrix.grid.colwidths";

type Widths = Record<string, number>;     // column name -> px
type Store = Record<string, Widths>;      // scopeKey -> widths

function load(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function save(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store));
}

export function scopeKey(
  connId: string,
  source?: { schema: string; table: string },
  tabId?: string,
): string {
  return source ? `conn:${connId}:${source.schema}.${source.table}` : `__query:${tabId ?? "_"}`;
}

export function getWidth(scope: string, column: string): number | undefined {
  return load()[scope]?.[column];
}

export function setWidth(scope: string, column: string, w: number): void {
  const store = load();
  if (!store[scope]) store[scope] = {};
  store[scope][column] = Math.round(w);
  save(store);
}

export function clearScope(scope: string): void {
  const store = load();
  delete store[scope];
  save(store);
}
