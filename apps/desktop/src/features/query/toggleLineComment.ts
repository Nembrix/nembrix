// Extracted from QueryTab so that file exports only its component — a
// component module with extra exports breaks React Fast Refresh
// (react-refresh/only-export-components).

import type { EditorView } from "@codemirror/view";

/** A line as (absolute start offset, text) — the minimal shape the comment
 *  toggler needs, so the core logic is testable without a real EditorView. */
export interface CommentLine {
  from: number;
  text: string;
}

/**
 * Pure core of the comment toggle: given the selected lines and a token
 * (`--` / `//`), return the document changes. If every non-blank line is
 * already commented, uncomment; otherwise comment. Indentation is preserved
 * (the token goes after leading whitespace). No DOM / EditorView needed.
 */
export function computeCommentToggle(
  lines: CommentLine[],
  token: string,
): { from: number; to?: number; insert?: string }[] {
  const prefix = token + " ";
  const nonBlank = lines.filter((l) => l.text.trim().length > 0);
  const allCommented =
    nonBlank.length > 0 &&
    nonBlank.every((l) => l.text.trimStart().startsWith(token));
  const changes: { from: number; to?: number; insert?: string }[] = [];
  for (const line of lines) {
    const indent = line.text.length - line.text.trimStart().length;
    if (allCommented) {
      const rest = line.text.slice(indent);
      if (rest.startsWith(token)) {
        const cut = rest.startsWith(prefix) ? prefix.length : token.length;
        changes.push({ from: line.from + indent, to: line.from + indent + cut });
      }
    } else if (line.text.trim().length > 0) {
      changes.push({ from: line.from + indent, insert: prefix });
    }
  }
  return changes;
}

/**
 * Toggle a line comment across the selected lines using the given token
 * (`--` for SQL, `//` for JavaScript). Written by hand (via
 * [`computeCommentToggle`]) rather than via `@codemirror/commands` to avoid a
 * monorepo dep-identity clash between the hoisted `@codemirror/state`/`view`
 * copies.
 */
export function toggleLineComment(view: EditorView, token: string): boolean {
  const { state } = view;
  const lineNums = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lineNums.add(n);
  }
  const lines: CommentLine[] = [...lineNums].map((n) => {
    const l = state.doc.line(n);
    return { from: l.from, text: l.text };
  });
  const changes = computeCommentToggle(lines, token);
  if (!changes.length) return false;
  view.dispatch(state.update({ changes }));
  return true;
}

