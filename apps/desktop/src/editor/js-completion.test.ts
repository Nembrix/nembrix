import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { buildJsScriptExtension, buildJsCompletionSource } from "./js-completion";
import type { SchemaTree } from "@/ipc/types";

const tree: SchemaTree = {
  databases: [
    {
      name: "test",
      schemas: [
        {
          name: "public",
          tables: [
            {
              name: "api_keys",
              columns: [
                { name: "id", type_name: "int4", nullable: false, default: null },
                { name: "name", type_name: "text", nullable: true, default: null },
              ],
              primary_key: ["id"],
              foreign_keys: [],
              indexes: [],
            },
          ],
          views: [],
          functions: [],
        },
      ],
    },
  ],
};

/**
 * Drive the extension's completion source the way CodeMirror would: build a
 * doc whose cursor sits at `|`, then ask for completions at that offset.
 */
function completeAt(doc: string, schema: SchemaTree | undefined = tree) {
  const pos = doc.indexOf("|");
  const text = doc.replace("|", "");
  // Drive the completion source directly against a bare state. Loading the
  // JS language here would pull a second copy of @codemirror/state through the
  // monorepo's nested installs and break EditorState's `instanceof` checks;
  // the source only needs a syntax tree, and `syntaxTree` degrades to an empty
  // one without a language, which exercises the non-string branches.
  const state = EditorState.create({ doc: text });
  // `CompletionContext` and `EditorState` can resolve to different copies of
  // @codemirror/state in this monorepo (nested installs), which TypeScript
  // sees as unrelated nominal types even though they are the same class at
  // runtime. The cast bridges only that duplication.
  const ctx = new CompletionContext(state as never, pos, true);
  const result = buildJsCompletionSource(schema)(ctx);
  if (!result) return [];
  return result.options.map((o) => o.label);
}

describe("buildJsScriptExtension", () => {
  it("builds an extension with and without a schema", () => {
    expect(() => buildJsScriptExtension(tree)).not.toThrow();
    expect(() => buildJsScriptExtension(undefined)).not.toThrow();
  });

  it("offers Date helpers in JS context", () => {
    const labels = completeAt("const t = Da|");
    expect(labels).toContain("Date.now");
    expect(labels).toContain("new Date");
  });

  it("offers try and the console error/warn channels", () => {
    const labels = completeAt("t|");
    expect(labels).toContain("try");
    expect(labels).toContain("console.error");
    expect(labels).toContain("console.warn");
  });

  it("offers array members after a dot, not top-level keywords", () => {
    const labels = completeAt("const rows = []; rows.|");
    expect(labels).toContain("forEach");
    expect(labels).toContain("map");
    expect(labels).toContain("entries");
    expect(labels).toContain("length");
    // A member position must not suggest statement keywords.
    expect(labels).not.toContain("const");
  });

  it("still completes db.query after typing 'db.'", () => {
    // Regression: the member branch matches any `.`, so `db.` must not be
    // hijacked into offering array members instead of the one API call.
    // API labels are dotted and matched from the start of the word.
    const labels = completeAt("await db.|");
    expect(labels).toContain("db.query");
    expect(labels).not.toContain("rowCount");
  });

  it("completes console channels after typing 'console.'", () => {
    const labels = completeAt("console.|");
    expect(labels).toContain("console.log");
    expect(labels).toContain("console.error");
    expect(labels).not.toContain("rowCount");
  });

  it("offers result metadata after a dot", () => {
    const labels = completeAt("const r = await db.query('x'); r.|");
    expect(labels).toContain("rowCount");
    expect(labels).toContain("columns");
  });

  // NOTE: the SQL-inside-a-string layer (tables/columns/keywords offered when
  // the cursor sits in a `db.query("…")` literal) is not covered here. It needs
  // a real JS parse tree, and loading @codemirror/lang-javascript in this
  // process pulls a second @codemirror/state through the monorepo's nested
  // installs, which breaks EditorState's `instanceof` checks. Covered manually
  // in the app; worth revisiting if the CodeMirror installs are ever hoisted.
});
