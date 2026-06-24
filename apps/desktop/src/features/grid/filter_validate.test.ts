import { describe, expect, it } from "vitest";
import { validateFilterValue } from "./filter_validate";

describe("validateFilterValue", () => {
  it("skips validation for null ops regardless of value", () => {
    expect(validateFilterValue("integer", "IS NULL", "anything")).toBeNull();
    expect(validateFilterValue("integer", "IS NOT NULL", "")).toBeNull();
  });

  it("requires non-empty value for LIKE/ILIKE on any type", () => {
    expect(validateFilterValue("integer", "LIKE", "")).toMatch(/required/);
    expect(validateFilterValue("text", "ILIKE", "%foo%")).toBeNull();
  });

  it("accepts non-empty value for CONTAINS family on any type", () => {
    expect(validateFilterValue("integer", "CONTAINS", "42")).toBeNull();
    expect(validateFilterValue("integer", "CONTAINS", "")).toMatch(/required/);
    expect(validateFilterValue("uuid", "ICONTAINS", "550e")).toBeNull();
    expect(validateFilterValue("text", "NOT CONTAINS", "foo")).toBeNull();
    expect(validateFilterValue("text", "NOT ICONTAINS", "")).toMatch(/required/);
  });

  it("accepts plain integers for int columns", () => {
    expect(validateFilterValue("integer", "=", "42")).toBeNull();
    expect(validateFilterValue("int8", "<", "-1")).toBeNull();
  });

  it("rejects non-numeric for int columns", () => {
    expect(validateFilterValue("integer", "=", "12.5")).toMatch(/integer/);
    expect(validateFilterValue("integer", "=", "abc")).toMatch(/integer/);
  });

  it("accepts decimals for numeric columns", () => {
    expect(validateFilterValue("numeric", "=", "12.5")).toBeNull();
    expect(validateFilterValue("float8", ">", "-0.001")).toBeNull();
    expect(validateFilterValue("numeric", "=", "abc")).toMatch(/number/);
  });

  it("validates booleans", () => {
    expect(validateFilterValue("bool", "=", "true")).toBeNull();
    expect(validateFilterValue("boolean", "=", "f")).toBeNull();
    expect(validateFilterValue("boolean", "=", "maybe")).toMatch(/true/);
  });

  it("validates uuids", () => {
    expect(validateFilterValue("uuid", "=", "550e8400-e29b-41d4-a716-446655440000")).toBeNull();
    expect(validateFilterValue("uuid", "=", "not-a-uuid")).toMatch(/uuid/);
  });

  it("validates dates and timestamps", () => {
    expect(validateFilterValue("date", "=", "2024-01-15")).toBeNull();
    expect(validateFilterValue("timestamptz", ">", "2024-01-15 14:30:00")).toBeNull();
    expect(validateFilterValue("timestamp", "=", "Jan 15 2024")).toMatch(/YYYY-MM-DD/);
  });

  it("validates JSON", () => {
    expect(validateFilterValue("jsonb", "=", '{"a":1}')).toBeNull();
    expect(validateFilterValue("json", "=", "not json")).toMatch(/JSON/);
  });

  it("returns null for unknown types (no opinion)", () => {
    expect(validateFilterValue("inet", "=", "192.168.1.1")).toBeNull();
    expect(validateFilterValue("bytea", "=", "anything")).toBeNull();
  });

  it("requires non-empty for text-like types", () => {
    expect(validateFilterValue("text", "=", "")).toMatch(/required/);
    expect(validateFilterValue("varchar", "=", "hello")).toBeNull();
  });
});
