import { describe, it, expect } from "vitest";
import { ENGINES, ENGINE_ORDER, engineSpec, engineLabel } from "./engines";

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

  it("marks postgres + mongo supported and the rest coming-soon", () => {
    expect(ENGINES.postgres.supported).toBe(true);
    expect(ENGINES.mongo.supported).toBe(true);
    expect(ENGINES.mysql.supported).toBe(false);
    expect(ENGINES.redis.supported).toBe(false);
  });

  it("gives each engine its well-known default port", () => {
    expect(ENGINES.postgres.defaultPort).toBe(5432);
    expect(ENGINES.mongo.defaultPort).toBe(27017);
    expect(ENGINES.mysql.defaultPort).toBe(3306);
    expect(ENGINES.redis.defaultPort).toBe(6379);
  });
});
