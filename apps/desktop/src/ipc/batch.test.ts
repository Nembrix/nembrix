import { describe, it, expect } from "vitest";
import { failedStatementIndex } from "./commands";

describe("failedStatementIndex", () => {
  it("reads the failing statement from an execute_batch error", () => {
    expect(failedStatementIndex(
      "statement 2 of 3 failed, nothing was applied: duplicate key value",
    )).toBe(1);
  });

  it("is null for other errors", () => {
    expect(failedStatementIndex("not connected")).toBeNull();
  });
});
