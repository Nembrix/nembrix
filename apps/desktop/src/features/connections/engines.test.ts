import { describe, it, expect } from "vitest";
import {
  ENGINES, ENGINE_ORDER, engineDialect, engineSpec, engineLabel, engineQueryLang, hasPgTools,
  isSqlEngine,
} from "./engines";

describe("engine registry", () => {
  it("labels known engines and falls back for unknown ones", () => {
    expect(engineLabel("postgres")).toBe("PostgreSQL");
    expect(engineLabel("mongo")).toBe("MongoDB");
    expect(engineLabel("cassandra")).toBe("cassandra"); // unknown → raw key
    expect(engineLabel(undefined)).toBe("Database");
  });

  it("exposes a spec with the expected shape for each ordered engine", () => {
    for (const key of ENGINE_ORDER) {
      const spec = engineSpec(key);
      expect(spec).toBeTruthy();
      expect(spec!.key).toBe(key);
      expect(typeof spec!.defaultPort).toBe("number");
      expect(spec!.fieldPlaceholders).toHaveProperty("user");
      expect(spec!.fieldPlaceholders).toHaveProperty("database");
      expect(typeof spec!.hasTls).toBe("boolean");
    }
  });

  it("marks every listed driver supported", () => {
    for (const key of ["postgres", "mysql", "mariadb", "mssql", "sqlite", "mongo", "redis"] as const) {
      expect(ENGINES[key].supported).toBe(true);
    }
  });

  it("asks for a file, not a server, only for SQLite", () => {
    expect(ENGINES.sqlite.fileBased).toBe(true);
    expect(engineDialect("sqlite")).toBe("sqlite");
    expect(hasPgTools("sqlite")).toBe(false);
    for (const key of ["postgres", "mysql", "mariadb", "mssql", "mongo", "redis"] as const) {
      expect(ENGINES[key].fileBased).toBeFalsy();
    }
  });

  it("knows each SQL engine's dialect and which have the Postgres tools", () => {
    expect(engineDialect("postgres")).toBe("postgres");
    expect(engineDialect("mysql")).toBe("mysql");
    expect(engineDialect("mariadb")).toBe("mysql");
    expect(engineDialect("mssql")).toBe("mssql");
    expect(hasPgTools("mssql")).toBe(false);
    expect(hasPgTools("postgres")).toBe(true);
    expect(hasPgTools("mysql")).toBe(false);
    expect(hasPgTools("redis")).toBe(false);
  });

  it("knows each engine's query language", () => {
    expect(engineQueryLang("postgres")).toBe("sql");
    expect(engineQueryLang("mongo")).toBe("mongo_shell");
    expect(engineQueryLang("redis")).toBe("redis_cmd");
    expect(isSqlEngine("postgres")).toBe(true);
    expect(isSqlEngine("mongo")).toBe(false);
    expect(isSqlEngine("redis")).toBe(false);
    // Unknown / not-yet-hydrated engines fall back to SQL, the historical path.
    expect(isSqlEngine(undefined)).toBe(true);
  });

  it("gives each engine its well-known default port", () => {
    expect(ENGINES.postgres.defaultPort).toBe(5432);
    expect(ENGINES.mongo.defaultPort).toBe(27017);
    expect(ENGINES.mysql.defaultPort).toBe(3306);
    expect(ENGINES.redis.defaultPort).toBe(6379);
    expect(ENGINES.mssql.defaultPort).toBe(1433);
  });

  it("defaults Mongo to TLS-off so a plain local Mongo connects", () => {
    // The Mongo driver reads `tls: ssl_mode != "disable"`. A "prefer" default
    // would flip TLS on and fail the handshake against a non-TLS Mongo.
    expect(ENGINES.mongo.sslDefault).toBe("disable");
    // SQL engines keep the TLS-preferring default.
    expect(ENGINES.postgres.sslDefault).toBe("prefer");
    expect(ENGINES.mysql.sslDefault).toBe("prefer");
  });
});
