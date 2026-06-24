import { describe, expect, it } from "vitest";
import { colorFor, destructiveReason, ENV_COLOR, isProtected } from "./environment";

describe("colorFor", () => {
  it("returns the env preset when no override is provided", () => {
    expect(colorFor("production", null)).toBe(ENV_COLOR.production);
    expect(colorFor("staging", null)).toBe(ENV_COLOR.staging);
  });

  it("uses the override when it's a valid hex value", () => {
    expect(colorFor("production", "#00ff00")).toBe("#00ff00");
    expect(colorFor("test", "#abc")).toBe("#abc");
  });

  it("ignores non-hex overrides and falls back to the env preset", () => {
    expect(colorFor("staging", "not a color")).toBe(ENV_COLOR.staging);
    expect(colorFor("staging", "")).toBe(ENV_COLOR.staging);
  });

  it("defaults to 'other' when env is undefined", () => {
    expect(colorFor(undefined, null)).toBe(ENV_COLOR.other);
  });
});

describe("isProtected", () => {
  it("treats production and staging as protected", () => {
    expect(isProtected("production")).toBe(true);
    expect(isProtected("staging")).toBe(true);
  });
  it("leaves dev/test/other unprotected", () => {
    expect(isProtected("development")).toBe(false);
    expect(isProtected("test")).toBe(false);
    expect(isProtected("other")).toBe(false);
    expect(isProtected(undefined)).toBe(false);
  });
});

describe("destructiveReason", () => {
  it("returns null on unprotected environments regardless of SQL", () => {
    expect(destructiveReason("development", "DROP TABLE users;")).toBeNull();
    expect(destructiveReason("test",        "TRUNCATE users;")).toBeNull();
  });

  it("returns null for read-only queries on protected envs", () => {
    expect(destructiveReason("production", "SELECT * FROM users;")).toBeNull();
    expect(destructiveReason("staging",    "EXPLAIN ANALYZE SELECT 1;")).toBeNull();
  });

  it("flags DROP / TRUNCATE / ALTER / GRANT / REVOKE on protected envs", () => {
    expect(destructiveReason("production", "DROP TABLE users;")).toMatch(/DROP/);
    expect(destructiveReason("production", "TRUNCATE users;")).toMatch(/TRUNCATE/);
    expect(destructiveReason("production", "ALTER TABLE users ADD COLUMN x int;")).toMatch(/ALTER/);
    expect(destructiveReason("production", "GRANT SELECT ON x TO y;")).toMatch(/GRANT/);
    expect(destructiveReason("production", "REVOKE ALL ON x FROM y;")).toMatch(/GRANT|REVOKE/);
  });

  it("calls out UPDATE/DELETE without WHERE as especially dangerous", () => {
    expect(destructiveReason("production", "DELETE FROM users;"))
      .toBe("UPDATE or DELETE without a WHERE clause");
    expect(destructiveReason("production", "UPDATE users SET name='x';"))
      .toBe("UPDATE or DELETE without a WHERE clause");
  });

  it("treats UPDATE/DELETE with WHERE as merely destructive", () => {
    expect(destructiveReason("production", "DELETE FROM users WHERE id = 1;"))
      .toBe("destructive statement");
    expect(destructiveReason("production", "UPDATE users SET x = 1 WHERE id = 1;"))
      .toBe("destructive statement");
  });
});
