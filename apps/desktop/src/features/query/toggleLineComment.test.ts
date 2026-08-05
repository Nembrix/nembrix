import { describe, it, expect } from "vitest";
import { computeCommentToggle, type CommentLine } from "./QueryTab";

/** Turn a document into (from, text) lines like CodeMirror would. */
function lines(doc: string): CommentLine[] {
  const out: CommentLine[] = [];
  let from = 0;
  for (const text of doc.split("\n")) {
    out.push({ from, text });
    from += text.length + 1; // + newline
  }
  return out;
}

/** Apply computed changes to a doc string (mimics EditorView.dispatch). */
function apply(doc: string, token: string): string {
  const changes = computeCommentToggle(lines(doc), token);
  // Apply right-to-left so earlier offsets stay valid.
  let out = doc;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) {
    if (c.insert != null) out = out.slice(0, c.from) + c.insert + out.slice(c.from);
    else if (c.to != null) out = out.slice(0, c.from) + out.slice(c.to);
  }
  return out;
}

describe("computeCommentToggle", () => {
  it("comments a single line with the SQL token", () => {
    expect(apply("SELECT 1", "--")).toBe("-- SELECT 1");
  });

  it("comments a single line with the JS token", () => {
    expect(apply("const x = 1", "//")).toBe("// const x = 1");
  });

  it("uncomments when already commented", () => {
    expect(apply("-- SELECT 1", "--")).toBe("SELECT 1");
    expect(apply("// const x = 1", "//")).toBe("const x = 1");
  });

  it("comments all selected lines, preserving indentation", () => {
    expect(apply("a\n  b\nc", "//")).toBe("// a\n  // b\n// c");
  });

  it("uncomments a fully-commented block", () => {
    expect(apply("// a\n// b", "//")).toBe("a\nb");
  });

  it("comments a mixed block (some commented) rather than uncommenting", () => {
    // Not ALL non-blank lines are commented → the toggle comments them all.
    expect(apply("// a\nb", "//")).toBe("// // a\n// b");
  });
});
