import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { buildRedisExtension } from "./redis-completion";
import type { SchemaTree } from "@/ipc/types";

const key = (name: string, type: string) => ({
  name,
  columns: [{ name: "value", type_name: type, nullable: true, default: null }],
  primary_key: [], foreign_keys: [], indexes: [],
});

const tree: SchemaTree = {
  databases: [{
    name: "db0",
    schemas: [{
      name: "db0",
      tables: [key("user:1", "string"), key("session:1", "hash")],
      views: [],
      functions: [],
    }],
  }],
};

/** Run the extension's completion source with the cursor at the end of `doc`. */
function complete(doc: string, explicit = false): CompletionResult | null {
  const state = EditorState.create({ doc, extensions: [buildRedisExtension(tree)] });
  const sources = state.languageDataAt<CompletionSource>("autocomplete", doc.length);
  expect(sources.length).toBe(1);
  return sources[0](new CompletionContext(state, doc.length, explicit)) as CompletionResult | null;
}

const labels = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? [];

describe("buildRedisExtension", () => {
  it("offers commands for the first word of a line", () => {
    expect(labels(complete("HG"))).toContain("HGETALL");
    expect(labels(complete("GET a\n  ZR"))).toContain("ZRANGE");
  });

  it("offers keys from the schema tree after the command", () => {
    const r = complete("HGETALL ses");
    expect(labels(r)).toEqual(["user:1", "session:1"]);
    expect(r?.from).toBe("HGETALL ".length);
    expect(r?.options[1].detail).toBe("hash");
  });

  it("stays quiet on an empty word unless asked", () => {
    expect(complete("GET ")).toBeNull();
    expect(labels(complete("GET ", true))).toContain("user:1");
  });

  it("builds without a schema", () => {
    expect(() => buildRedisExtension(undefined)).not.toThrow();
  });
});
