import { describe, expect, it } from "vitest";
import { validateConnectionName } from "./validateConnectionName";

// Minimal shape the validator reads — id + name.
const conn = (id: string, name: string) => ({ id, name });

describe("validateConnectionName", () => {
  it("requires a non-empty name", () => {
    expect(validateConnectionName("", [], null)).toBe("Name is required.");
    expect(validateConnectionName("   ", [], null)).toBe("Name is required.");
  });

  it("accepts any non-empty name", () => {
    const existing = [conn("1", "Prod"), conn("2", "Staging")];
    expect(validateConnectionName("Local", existing, null)).toBeNull();
  });

  it("allows duplicate names (case-insensitive too)", () => {
    const existing = [conn("1", "Prod")];
    expect(validateConnectionName("prod", existing, null)).toBeNull();
    expect(validateConnectionName("  PROD  ", existing, null)).toBeNull();
    expect(validateConnectionName("Prod", existing, "1")).toBeNull();
  });
});
