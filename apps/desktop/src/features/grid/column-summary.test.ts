import { describe, it, expect } from "vitest";
import { summarizeColumn } from "./column-summary";
import type { CellValue } from "@/ipc/types";

const text  = (s: string): CellValue => ({ kind: "text", value: s });
const num   = (n: number): CellValue => ({ kind: "int", value: n });
const NULLV: CellValue = { kind: "null" };

describe("summarizeColumn", () => {
  it("counts nulls and distinct values", () => {
    const s = summarizeColumn([text("a"), text("a"), text("b"), NULLV, NULLV]);
    expect(s.total).toBe(5);
    expect(s.nulls).toBe(2);
    expect(s.distinct).toBe(2);
    expect(s.numeric).toBe(false);
  });

  it("computes min/max/sum/avg for numeric columns", () => {
    const s = summarizeColumn([num(1), num(2), num(3), num(4)]);
    expect(s.numeric).toBe(true);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
    expect(s.sum).toBe(10);
    expect(s.avg).toBe(2.5);
  });

  it("does NOT report numeric stats when any non-null is non-numeric", () => {
    const s = summarizeColumn([num(1), text("two"), num(3)]);
    expect(s.numeric).toBe(false);
    expect(s.min).toBeUndefined();
  });

  it("returns top-N by frequency, descending", () => {
    const data: CellValue[] = [
      ...Array(5).fill(text("a")),
      ...Array(3).fill(text("b")),
      ...Array(2).fill(text("c")),
    ];
    const s = summarizeColumn(data);
    expect(s.top.slice(0, 3)).toEqual([
      { value: "a", count: 5 },
      { value: "b", count: 3 },
      { value: "c", count: 2 },
    ]);
  });
});
