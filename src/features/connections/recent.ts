/**
 * Recent connections list.
 *
 * Tracks the last N connection ids the user has opened a session for,
 * most-recent first. Persisted in localStorage so it survives reload —
 * helpful since live sessions don't yet (task #65).
 *
 * Pure-frontend; the Rust/sidecar backends know nothing about this.
 */

const KEY = "nembrix.recent.connections.v1";
const MAX = 10;

export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Move `connId` to the front of the recents list, dropping the oldest
 *  if we exceed MAX. Idempotent (re-bumping the same id just promotes). */
export function bumpRecent(connId: string): string[] {
  const cur = loadRecent();
  const next = [connId, ...cur.filter((id) => id !== connId)].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

/** Remove a connection from the recents list — call when the underlying
 *  saved connection is deleted, so we don't show stale ghosts. */
export function forgetRecent(connId: string): string[] {
  const cur = loadRecent().filter((id) => id !== connId);
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* ignore */ }
  return cur;
}
