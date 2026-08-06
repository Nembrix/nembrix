import { describe, it, expect } from "vitest";
import { buildMongoExtension } from "./mongo-completion";
import type { SchemaTree } from "@/ipc/types";

const tree: SchemaTree = {
  databases: [
    {
      name: "test",
      schemas: [
        {
          name: "test",
          tables: [
            { name: "users", columns: [], primary_key: [], foreign_keys: [], indexes: [] },
            { name: "orders", columns: [], primary_key: [], foreign_keys: [], indexes: [] },
          ],
          views: [],
          functions: [],
        },
      ],
    },
  ],
};

describe("buildMongoExtension", () => {
  it("builds an extension without throwing (with and without a schema)", () => {
    expect(() => buildMongoExtension(tree)).not.toThrow();
    expect(() => buildMongoExtension(undefined)).not.toThrow();
  });

  it("returns a non-empty extension array", () => {
    const ext = buildMongoExtension(tree) as unknown[];
    expect(Array.isArray(ext)).toBe(true);
    expect(ext.length).toBeGreaterThan(0);
  });
});
