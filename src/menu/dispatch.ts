import { isTauri } from "@/ipc/commands";
import { useStore } from "@/store";
import { isEnabled } from "./availability";
import type { MenuId } from "./ids";

export type MenuHandler = (suffix?: string) => void | Promise<void>;
const handlers = new Map<string, MenuHandler>();
/** Prefix-matched handlers — used for dynamic ids like
 *  `conn.recent:<connectionId>` where the suffix is data, not a known id. */
const prefixHandlers = new Map<string, MenuHandler>();

export function registerMenu(id: MenuId, fn: MenuHandler) {
  handlers.set(id, fn);
}
export function registerMenuPrefix(prefix: string, fn: MenuHandler) {
  prefixHandlers.set(prefix, fn);
}
export function unregisterMenu(id: MenuId) {
  handlers.delete(id);
}

/**
 * Dispatch a menu id. Refuses to fire if the id is currently disabled by
 * the availability rules — defense in depth so a stale keybind or a buggy
 * caller can't trigger an action that has no context.
 *
 * Pass `{ force: true }` to bypass the check — used by the palette when the
 * user explicitly opens a disabled action to see what would unblock it.
 */
export async function dispatchMenu(id: string, opts: { force?: boolean } = {}) {
  // Exact match first; fall back to a prefix match for dynamic ids.
  let h = handlers.get(id);
  let suffix: string | undefined;
  if (!h) {
    for (const [prefix, fn] of prefixHandlers) {
      if (id.startsWith(prefix)) {
        h = fn;
        suffix = id.slice(prefix.length);
        break;
      }
    }
  }
  if (!h) {
    console.warn(`[menu] no handler for "${id}"`);
    return;
  }
  if (!opts.force && !isEnabled(id as MenuId, useStore.getState())) {
    console.warn(`[menu] "${id}" is disabled in the current context`);
    return;
  }
  await h(suffix);
}

let started = false;
let unlistenFn: (() => void) | null = null;

/** Subscribe to native `menu:invoke` events. Idempotent. */
export async function startMenuBridge() {
  if (started) return;
  started = true;
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<string>("menu:invoke", (e) => {
    dispatchMenu(e.payload);
  });
  unlistenFn = un;
}
export function stopMenuBridge() {
  if (unlistenFn) unlistenFn();
  unlistenFn = null;
  started = false;
}
