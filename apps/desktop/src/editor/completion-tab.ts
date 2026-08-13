import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";

/**
 * Make Tab accept the highlighted item WHILE the autocomplete popup is open.
 *
 * CodeMirror's default completion keymap accepts on Enter, not Tab — so with the
 * popup open, pressing Tab fell through to the indent command and pushed the
 * text over instead of completing. This binds Tab (and Shift-Tab) to
 * `acceptCompletion`, but ONLY when a completion is active: `completionStatus`
 * is null when the popup is closed, so we return false and Tab behaves normally
 * (indent) as before. High precedence so it wins over the indent keymap.
 */
export const completionTabKeymap: Extension = Prec.highest(
  keymap.of([
    {
      key: "Tab",
      run: (view) =>
        completionStatus(view.state) != null ? acceptCompletion(view) : false,
    },
    {
      key: "Shift-Tab",
      run: (view) =>
        completionStatus(view.state) != null ? acceptCompletion(view) : false,
    },
  ]),
);
