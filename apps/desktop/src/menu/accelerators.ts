import { isTauri } from "@/ipc/commands";
import { dispatchMenu } from "./dispatch";
import { MENU } from "./ids";

/**
 * Browser-mode keyboard accelerators. The OS menu handles these natively in
 * Tauri; here we wire them by hand so `npm run dev` matches.
 *
 * Predefined Edit commands (cut/copy/paste/undo/redo/select all) are left
 * to the browser — CodeMirror handles them itself.
 */
type Binding = { combo: string; id: string };

const BINDINGS: Binding[] = [
  { combo: "mod+n",       id: MENU.NEW_CONNECTION },
  { combo: "mod+t",       id: MENU.NEW_QUERY_TAB },
  { combo: "mod+shift+n", id: MENU.NEW_WINDOW },
  { combo: "mod+o",       id: MENU.OPEN_SAVED_QUERY },
  { combo: "mod+s",       id: MENU.SAVE_QUERY },
  { combo: "mod+shift+s", id: MENU.SAVE_QUERY_AS },
  { combo: "mod+w",       id: MENU.CLOSE_TAB },

  { combo: "mod+p",       id: MENU.COMMAND_PALETTE },
  { combo: "mod+shift+p", id: MENU.COMMAND_PALETTE },
  // ⌘K is reserved for Connect, so the palette uses ⌘P / ⇧⌘P (VS Code style).
  { combo: "mod+0",       id: MENU.TOGGLE_RAIL },
  { combo: "mod+1",       id: MENU.TOGGLE_INSPECTOR },
  { combo: "mod+2",       id: MENU.TOGGLE_RESULTS },

  { combo: "mod+k",       id: MENU.CONNECT },
  { combo: "mod+shift+k", id: MENU.DISCONNECT },
  { combo: "mod+shift+l", id: MENU.MANAGE_CONNECTIONS },
  { combo: "mod+r",       id: MENU.REFRESH_SCHEMA },
  { combo: "mod+shift+r", id: MENU.APP_RELOAD },

  { combo: "mod+return",  id: MENU.QUERY_RUN_CURRENT },
  { combo: "mod+shift+return", id: MENU.QUERY_RUN_ALL },
  { combo: "mod+.",       id: MENU.QUERY_CANCEL },
  { combo: "mod+i",       id: MENU.QUERY_FORMAT },
  { combo: "mod+/",       id: MENU.QUERY_TOGGLE_COMMENT },
  { combo: "mod+,",       id: MENU.PREFERENCES },
];

function matches(e: KeyboardEvent, combo: string) {
  const parts = combo.split("+");
  const want = {
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt") || parts.includes("opt"),
    key: parts[parts.length - 1].toLowerCase(),
  };
  const mod = e.metaKey || e.ctrlKey;
  if (mod !== want.mod) return false;
  if (e.shiftKey !== want.shift) return false;
  if (e.altKey !== want.alt) return false;
  const k = e.key === "Enter" ? "return" : e.key.toLowerCase();
  return k === want.key;
}

let installed = false;

export function installAccelerators() {
  if (installed || isTauri) return;
  installed = true;
  window.addEventListener("keydown", (e) => {
    // Never steal keys while the user is typing in a plain form field
    // (connection form inputs, filter values, dialogs, …). Otherwise combos
    // like ⌘A (select all), ⌘C/⌘X/⌘V (clipboard) get preventDefault()ed or
    // trigger a menu action — e.g. ⌘W would close the window mid-edit. Text
    // editors (CodeMirror) manage their own keymap and shouldn't be caught
    // here either. The command palette (⌘P/⌘⇧P) stays global so it can be
    // opened from anywhere.
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    const editable =
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      t?.isContentEditable === true ||
      !!t?.closest(".cm-editor");
    for (const b of BINDINGS) {
      if (matches(e, b.combo)) {
        const isPalette = b.id === MENU.COMMAND_PALETTE;
        if (editable && !isPalette) return; // let the field handle it
        e.preventDefault();
        dispatchMenu(b.id);
        return;
      }
    }
  });
}
