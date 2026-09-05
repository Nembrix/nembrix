import { describe, it, expect } from "vitest";
import { buildAddColumnSql } from "./buildAddColumnSql";

describe("buildAddColumnSql", () => {
  it("builds a basic nullable column", () => {
    expect(buildAddColumnSql("public", "users", "nickname", "text", true, "")).toBe(
      'ALTER TABLE "public"."users" ADD COLUMN "nickname" text;',
    );
  });

  it("appends NOT NULL when not nullable", () => {
    expect(buildAddColumnSql("public", "users", "age", "integer", false, "")).toBe(
      'ALTER TABLE "public"."users" ADD COLUMN "age" integer NOT NULL;',
    );
  });

  it("appends a DEFAULT expression before NOT NULL", () => {
    expect(buildAddColumnSql("public", "users", "created", "timestamptz", false, "now()")).toBe(
      'ALTER TABLE "public"."users" ADD COLUMN "created" timestamptz DEFAULT now() NOT NULL;',
    );
  });

  it("quotes identifiers and doubles embedded quotes", () => {
    expect(buildAddColumnSql('s"x', 't"y', 'c"z', "text", true, "")).toBe(
      'ALTER TABLE "s""x"."t""y" ADD COLUMN "c""z" text;',
    );
  });
});
