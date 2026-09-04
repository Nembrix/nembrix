/**
 * Push availability snapshots to the native menu (no-op in browser dev).
 *
 * We subscribe to the entire Zustand store and recompute the disabled set
 * on every change, but only call the Tauri command when the set actually
 * changes. That keeps the OS-level IPC quiet during typing in the editor.
 */

import { isTauri, updateMenuState } from "@/ipc/commands";
import { useStore } from "@/store";
import { disabledIds } from "./availability";
import { checkedIds } from "./checked";

let lastSerialized = "";
let installed = false;

export function startMenuStateSync() {
  if (installed || !isTauri) return;
  installed = true;

  const push = () => {
    const st = useStore.getState();
    const ids = disabledIds(st);
    const checked = checkedIds(st);
    // Serialize BOTH sets — keying the dedupe on the disabled set alone would
    // swallow a pure panel toggle (which changes only `checked`) and leave the
    // native tick stale.
    const serialized = `${ids.join(",")}|${checked.join(",")}`;
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    // Fire-and-forget; the menu is non-critical.
    updateMenuState(ids, checked).catch((e) =>
      console.warn("[menu] update_menu_state failed:", e),
    );
  };

  // Initial push, then on every store change.
  push();
  useStore.subscribe(push);
}
