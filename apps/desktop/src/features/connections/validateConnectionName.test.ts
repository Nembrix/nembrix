import { describe, expect, it } from "vitest";
import { validateConnectionName } from "./validateConnectionName";

// Minimal shape the validator reads — id + name.
const conn = (id: string, name: string) => ({ id, name });

describe("validateConnectionName", () => {
  it("requires a non-empty name", () => {
    expect(validateConnectionName("", [], null)).toBe("Name is required.");
    expect(validateConnectionName("   ", [], null)).toBe("Name is required.");
  });

  it("accepts a unique name", () => {
    const existing = [conn("1", "Prod"), conn("2", "Staging")];
    expect(validateConnectionName("Local", existing, null)).toBeNull();
  });

  it("rejects a duplicate name (case-insensitive, trimmed)", () => {
    const existing = [conn("1", "Prod")];
    expect(validateConnectionName("prod", existing, null)).toBe(
      "A connection with this name already exists.",
    );
    expect(validateConnectionName("  PROD  ", existing, null)).toBe(
      "A connection with this name already exists.",
    );
  });

  it("does not clash with itself when editing", () => {
    const existing = [conn("1", "Prod"), conn("2", "Staging")];
    // Editing connection "1", keeping its own name, is valid.
    expect(validateConnectionName("Prod", existing, "1")).toBeNull();
    // But renaming it to another existing name still clashes.
    expect(validateConnectionName("Staging", existing, "1")).toBe(
      "A connection with this name already exists.",
    );
  });
});
