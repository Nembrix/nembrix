/**
 * Local slow-query log.
 *
 * Every query whose elapsed time exceeds the threshold is appended to
 * a ring buffer in localStorage. Stays on the user's machine — we
 * don't ship it anywhere — so this is safe to enable by default.
 *
 * Why local-only? The DB itself has `pg_stat_statements` but that's
 * server-side and the user might not have rights to enable it. A
 * client-side log catches queries the user actually ran (including
 * ad-hoc EXPLAINs) without touching the server config.
 */

const STORAGE_KEY = "nembrix.slowQueries.v1";
const SETTINGS_KEY = "nembrix.slowQueries.settings.v1";
const DEFAULT_LIMIT = 500;
const DEFAULT_THRESHOLD_MS = 500;

export interface SlowQueryEntry {
  id: string;
  connId: string;
  /** A short label the UI can show without re-keying off connId, since
   *  connection names can be renamed but the log shouldn't lose context. */
  connName?: string;
  sql: string;
  elapsedMs: number;
  at: number; // epoch ms
}

export interface SlowQuerySettings {
  thresholdMs: number;
  limit: number;
  enabled: boolean;
}

export function loadSettings(): SlowQuerySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        thresholdMs: typeof parsed.thresholdMs === "number" ? parsed.thresholdMs : DEFAULT_THRESHOLD_MS,
        limit: typeof parsed.limit === "number" ? parsed.limit : DEFAULT_LIMIT,
        enabled: parsed.enabled !== false,
      };
    }
  } catch { /* corrupt; fall through */ }
  return { thresholdMs: DEFAULT_THRESHOLD_MS, limit: DEFAULT_LIMIT, enabled: true };
}

export function saveSettings(s: SlowQuerySettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function loadSlowQueries(): SlowQueryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => typeof e.sql === "string" && typeof e.elapsedMs === "number");
  } catch { return []; }
}

export function recordSlowQuery(entry: Omit<SlowQueryEntry, "id" | "at">, at: number): void {
  const settings = loadSettings();
  if (!settings.enabled) return;
  if (entry.elapsedMs < settings.thresholdMs) return;
  const log = loadSlowQueries();
  const full: SlowQueryEntry = {
    id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    ...entry,
  };
  log.unshift(full);
  // Keep the buffer bounded so localStorage doesn't grow unbounded over months.
  if (log.length > settings.limit) log.length = settings.limit;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(log)); } catch { /* ignore */ }
}

export function clearSlowQueries(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
