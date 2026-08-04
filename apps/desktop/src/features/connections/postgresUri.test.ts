import { describe, expect, it } from "vitest";
import { buildPostgresUri, parsePostgresUri } from "./postgresUri";
import type { ConnectionInput } from "@/ipc/types";

const base: ConnectionInput = {
  id: null,
  name: "",
  engine: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "postgres",
  password: "",
  database: "postgres",
  ssl_mode: "prefer",
  ssh: null,
  color: null,
  environment: "development",
};

describe("parsePostgresUri", () => {
  it("parses a full managed-Postgres URL (the real regression case)", () => {
    const url =
      "postgresql://muc_mwindalab_koolsend_api_f2ab11_user:f59ohLz3OAZG6Rd3D-aET8AUOQZPEjkpj8qo-aUqEqc@postgres.clymist.com:30432/muc_mwindalab_koolsend_api?sslmode=require";
    const out = parsePostgresUri(url);
    expect(out).toEqual({
      host: "postgres.clymist.com",
      port: 30432,
      username: "muc_mwindalab_koolsend_api_f2ab11_user",
      password: "f59ohLz3OAZG6Rd3D-aET8AUOQZPEjkpj8qo-aUqEqc",
      database: "muc_mwindalab_koolsend_api",
      ssl_mode: "require",
    });
  });

  it("keeps the password intact when it contains hyphens/underscores", () => {
    const out = parsePostgresUri("postgres://u:a-b_c-d@h:5432/db");
    expect(out?.password).toBe("a-b_c-d");
  });

  it("percent-decodes url-encoded credentials", () => {
    const out = parsePostgresUri("postgres://user%40corp:p%40ss%2Fword@h:5432/db");
    expect(out?.username).toBe("user@corp");
    expect(out?.password).toBe("p@ss/word");
  });

  it("accepts both postgres:// and postgresql:// schemes", () => {
    expect(parsePostgresUri("postgres://u:p@h/db")?.host).toBe("h");
    expect(parsePostgresUri("postgresql://u:p@h/db")?.host).toBe("h");
  });

  it("only accepts known ssl modes, ignores others", () => {
    expect(parsePostgresUri("postgres://u:p@h/db?sslmode=require")?.ssl_mode).toBe("require");
    expect(parsePostgresUri("postgres://u:p@h/db?sslmode=verify-full")?.ssl_mode).toBeUndefined();
  });

  it("returns null for non-postgres or unparseable input", () => {
    expect(parsePostgresUri("")).toBeNull();
    expect(parsePostgresUri("mysql://u:p@h/db")).toBeNull();
    expect(parsePostgresUri("not a url")).toBeNull();
  });
});

describe("buildPostgresUri", () => {
  it("omits the password (never rendered back into a visible field)", () => {
    const uri = buildPostgresUri({ ...base, username: "alice", password: "secret", host: "db.example", port: 5432, database: "shop" });
    expect(uri).not.toContain("secret");
    expect(uri).toBe("postgresql://alice@db.example:5432/shop");
  });

  it("includes sslmode only when it isn't the default (prefer)", () => {
    expect(buildPostgresUri({ ...base, ssl_mode: "prefer" })).not.toContain("sslmode");
    expect(buildPostgresUri({ ...base, ssl_mode: "require" })).toContain("sslmode=require");
  });

  it("round-trips host/port/user/db/ssl through parse → build (password aside)", () => {
    const parsed = parsePostgresUri(
      "postgresql://alice:pw@db.example:6543/shop?sslmode=require",
    );
    const rebuilt = buildPostgresUri({ ...base, ...parsed });
    // Password is dropped from the display URI by design; everything else survives.
    expect(rebuilt).toBe("postgresql://alice@db.example:6543/shop?sslmode=require");
    expect(parsed?.password).toBe("pw");
  });
});
