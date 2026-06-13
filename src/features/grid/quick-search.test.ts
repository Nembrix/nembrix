import { describe, expect, it } from "vitest";
import { CELL_SEP, matches, stringifyCell, stringifyRow } from "./quick-search";
import type { CellValue } from "@/ipc/types";

const text = (s: string): CellValue => ({ kind: "text", value: s });
const int  = (n: number): CellValue => ({ kind: "int",  value: n });
const NUL  : CellValue = { kind: "null" };
const json = (v: unknown): CellValue => ({ kind: "document", value: v });
const bytes = (xs: number[]): CellValue => ({ kind: "bytes", value: xs });

describe("stringifyCell", () => {
  it("renders empty for NULL so it doesn't accidentally match", () => {
    expect(stringifyCell(NUL)).toBe("");
  });
  it("renders bools, ints, text, raw, documents and bytes", () => {
    expect(stringifyCell({ kind: "bool", value: true })).toBe("true");
    expect(stringifyCell(int(42))).toBe("42");
    expect(stringifyCell(text("alice"))).toBe("alice");
    expect(stringifyCell(json({ k: 1 }))).toBe(`{"k":1}`);
    expect(stringifyCell(bytes([0xde, 0xad]))).toBe("dead");
  });
});

describe("stringifyRow", () => {
  it("uses CELL_SEP between cells so adjacent values don't merge", () => {
    expect(stringifyRow([int(1), text("alice")])).toBe(`1${CELL_SEP}alice`);
  });
});

describe("matches", () => {
  const rows: CellValue[][] = [
    [int(1), text("alice@example.com"), text("Alice"),  text("active")],
    [int(2), text("bob@example.com"),   text("Bob"),    text("idle")],
    [int(3), text("carol@example.com"), text("Carol"),  NUL],
    [int(4), text("dan@other.io"),      text("Dan"),    text("active")],
  ];

  it("returns every row index when the needle is empty", () => {
    expect(matches("", rows).map((m) => m.index)).toEqual([0, 1, 2, 3]);
  });

  it("does substring match across all cells in a row", () => {
    expect(matches("alice", rows).map((m) => m.index)).toEqual([0]);
    expect(matches("example.com", rows).map((m) => m.index)).toEqual([0, 1, 2]);
    expect(matches("other.io", rows).map((m) => m.index)).toEqual([3]);
  });

  it("is case-insensitive", () => {
    expect(matches("ALICE", rows).map((m) => m.index)).toEqual([0]);
    expect(matches("Active", rows).map((m) => m.index)).toEqual([0, 3]);
  });

  it("returns positions for matches in the row's haystack", () => {
    const m = matches("active", rows);
    expect(m[0].index).toBe(0);
    expect(m[0].positions.length).toBeGreaterThan(0);
  });

  it("doesn't match across cell boundaries (separator inserted)", () => {
    // row 1 is [Bob, idle] — "bobidle" would match if cells were concatenated raw,
    // but the unit separator prevents it.
    expect(matches("bobidle", rows)).toHaveLength(0);
  });

  it("handles NULL cells without crashing", () => {
    expect(matches("CAROL", rows).map((m) => m.index)).toEqual([2]);
    expect(matches("zzz", rows)).toHaveLength(0);
  });
});
