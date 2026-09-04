/**
 * Single source of truth for which menu items render as *checked*.
 *
 * Companion to `availability.ts` (enabled/disabled): same shape, same
 * consumers. Toggle items ("Toggle Results Pane") previously read the same
 * whether the pane was showing or hidden, so an accidental ⌘2 looked like the
 * app had lost the panel rather than hidden it.
 *
 * Predicates are pure (snapshot → boolean) so they're trivially testable.
 * Ids absent from the map are not checkable and render as plain rows.
 */

import { MENU, type MenuId } from "./ids";
import type { useStore } from "@/store";

type Snapshot = ReturnType<typeof useStore.getState>;

type Predicate = (s: Snapshot) => boolean;

/**
 * Map of menu id → "is this checked right now". An id absent from this map is
 * not a checkable item.
 */
const RULES: Partial<Record<MenuId, Predicate>> = {
  [MENU.TOGGLE_RAIL]: (s) => s.panels.rail,
  [MENU.TOGGLE_INSPECTOR]: (s) => s.panels.inspector,
  [MENU.TOGGLE_RESULTS]: (s) => s.panels.results,
};

/** True when `id` is a checkable item (i.e. it has a rule). */
export function isCheckable(id: MenuId): boolean {
  return id in RULES;
}

export function isChecked(id: MenuId, s: Snapshot): boolean {
  const p = RULES[id];
  return p ? p(s) : false;
}

/**
 * Ids currently checked, for the native menu sync. Mirrors
 * `availability.disabledIds` — we push the whole set and let the Rust side
 * diff it against the checkable items it owns.
 */
export function checkedIds(s: Snapshot): string[] {
  const out: string[] = [];
  for (const id of Object.keys(RULES) as MenuId[]) {
    if (isChecked(id, s)) out.push(id);
  }
  return out;
}

/** Every id that renders as a checkbox, checked or not. */
export function checkableIds(): string[] {
  return Object.keys(RULES);
}
