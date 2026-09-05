import { describe, it, expect } from "vitest";
import { buildCreateIndexSql } from "./buildCreateIndexSql";

describe("buildCreateIndexSql", () => {
  it("builds a single-column index with a derived name", () => {
    expect(buildCreateIndexSql("public", "users", ["email"], false)).toBe(
      'CREATE INDEX "users_email_idx" ON "public"."users" ("email");',
    );
  });

  it("builds a multi-column index", () => {
    expect(buildCreateIndexSql("public", "orders", ["user_id", "created_at"], false)).toBe(
      'CREATE INDEX "orders_user_id_created_at_idx" ON "public"."orders" ("user_id", "created_at");',
    );
  });

  it("builds a UNIQUE index when requested", () => {
    expect(buildCreateIndexSql("public", "users", ["email"], true)).toBe(
      'CREATE UNIQUE INDEX "users_email_idx" ON "public"."users" ("email");',
    );
  });

  it("quotes identifiers and doubles embedded quotes", () => {
    expect(buildCreateIndexSql('s"x', 't', ['c"z'], false)).toBe(
      'CREATE INDEX "t_c""z_idx" ON "s""x"."t" ("c""z");',
    );
  });
});
