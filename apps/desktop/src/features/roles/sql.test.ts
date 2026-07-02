import { describe, expect, it } from "vitest";
import {
  alterRoleSql, createRoleSql, dropRoleSql, grantSql, qi,
  relationPrivsForRoleInSchema, ROLES_QUERY, ROLE_DATABASES_QUERY,
} from "./sql";

describe("qi (identifier quoting)", () => {
  it("double-quotes the identifier", () => {
    expect(qi("users")).toBe('"users"');
  });
  it("escapes embedded double quotes by doubling them", () => {
    expect(qi('a"b')).toBe('"a""b"');
  });
});

describe("createRoleSql", () => {
  it("composes the role attribute list in a stable order", () => {
    const sql = createRoleSql({
      name: "qa",
      password: "s3cr3t",
      canLogin: true,
      isSuper: false,
      canCreatedb: false,
      canCreaterole: false,
      inherits: true,
    });
    expect(sql).toBe(
      `CREATE ROLE "qa" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD 's3cr3t';`,
    );
  });

  it("includes CONNECTION LIMIT and VALID UNTIL when set", () => {
    const sql = createRoleSql({
      name: "rotater",
      canLogin: true,
      isSuper: false,
      canCreatedb: false,
      canCreaterole: false,
      inherits: true,
      connLimit: 5,
      validUntil: "2030-01-01",
    });
    expect(sql).toContain("CONNECTION LIMIT 5");
    expect(sql).toContain("VALID UNTIL '2030-01-01'");
  });

  it("escapes single quotes in passwords", () => {
    const sql = createRoleSql({
      name: "x",
      password: "O'Brien",
      canLogin: true,
      isSuper: false,
      canCreatedb: false,
      canCreaterole: false,
      inherits: true,
    });
    expect(sql).toContain("PASSWORD 'O''Brien'");
  });
});

describe("dropRoleSql", () => {
  it("uses the three-statement REASSIGN → DROP OWNED → DROP ROLE pattern", () => {
    const sql = dropRoleSql("qa", "postgres");
    const lines = sql.split("\n");
    expect(lines[0]).toBe(`REASSIGN OWNED BY "qa" TO "postgres";`);
    expect(lines[1]).toBe(`DROP OWNED BY "qa";`);
    expect(lines[2]).toBe(`DROP ROLE "qa";`);
  });
});

describe("alterRoleSql", () => {
  it("emits only the attributes that were explicitly set", () => {
    const sql = alterRoleSql("qa", { canCreatedb: true, inherits: false });
    expect(sql).toBe(`ALTER ROLE "qa" WITH CREATEDB NOINHERIT;`);
  });
});

describe("grantSql", () => {
  it("table-scoped GRANT uses ON schema.relation TO role", () => {
    expect(grantSql("qa", {
      scope: "table", schema: "public", relation: "users",
      privilege: "SELECT", grant: true,
    })).toBe(`GRANT SELECT ON "public"."users" TO "qa";`);
  });

  it("schema-scoped REVOKE uses ON SCHEMA name FROM role", () => {
    expect(grantSql("qa", {
      scope: "schema", schema: "public",
      privilege: "USAGE", grant: false,
    })).toBe(`REVOKE USAGE ON SCHEMA "public" FROM "qa";`);
  });

  it("database-scoped CONNECT", () => {
    expect(grantSql("qa", {
      scope: "database", database: "demo",
      privilege: "CONNECT", grant: true,
    })).toBe(`GRANT CONNECT ON DATABASE "demo" TO "qa";`);
  });
});

describe("catalog queries", () => {
  it("ROLES_QUERY references pg_roles + pg_auth_members", () => {
    expect(ROLES_QUERY).toMatch(/FROM pg_roles/);
    expect(ROLES_QUERY).toMatch(/pg_auth_members/);
  });
  it("ROLE_DATABASES_QUERY selects (role, database) via has_database_privilege CONNECT", () => {
    expect(ROLE_DATABASES_QUERY).toMatch(/has_database_privilege\(r\.oid, d\.oid, 'CONNECT'\)/);
    expect(ROLE_DATABASES_QUERY).toMatch(/d\.datallowconn/);
    expect(ROLE_DATABASES_QUERY).toMatch(/r\.rolname AS role/);
    expect(ROLE_DATABASES_QUERY).toMatch(/d\.datname AS database/);
  });
  it("relationPrivsForRoleInSchema inserts the role + schema and asks has_table_privilege", () => {
    const sql = relationPrivsForRoleInSchema("qa", "public");
    expect(sql).toContain("has_table_privilege('qa'");
    expect(sql).toContain("WHERE n.nspname = 'public'");
    // One column per privilege.
    for (const p of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
      expect(sql).toContain(`p_${p}`);
    }
  });
});
