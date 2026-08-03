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

/**
 * Grow the last column to absorb any horizontal slack, so the grid fills
 * the viewport instead of leaving an empty band on the right when there
 * are only a few narrow columns.
 *
 * Pure so it can be unit-tested. Returns a NEW array (or the same array
 * when nothing changes). No-ops — leaving the caller's filler-column
 * fallback to handle the row rules — when:
 *   - there are no columns,
 *   - the last column has a user-set (dragged) width (`lastIsManual`),
 *   - or there's no slack (columns already meet/exceed the viewport).
 *
 * @param widths   base per-column widths (px)
 * @param gutterW  width of the row-number gutter (px)
 * @param contentW usable content width of the scroll container (px)
 * @param lastIsManual whether the last column's width was set by the user
 */
export function stretchLastColumn(
  widths: number[],
  gutterW: number,
  contentW: number,
  lastIsManual: boolean,
): number[] {
  if (widths.length === 0 || lastIsManual) return widths;
  const base = gutterW + widths.reduce((a, b) => a + b, 0);
  const slack = contentW - base;
  if (slack <= 0) return widths;
  const next = widths.slice();
  next[next.length - 1] += slack;
  return next;
}
