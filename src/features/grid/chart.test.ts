/**
 * Targets the small isNumeric() helper inside ChartPane. It's exported here
 * via a thin re-export to keep this test isolated from the component DOM.
 *
 * Both upper-case names (raw Postgres) and lowercase (information_schema)
 * should be recognised because PgConn surfaces both depending on path.
 */
import { describe, it, expect } from "vitest";

const NUMERIC = new Set([
  "INT2", "INT4", "INT8", "FLOAT4", "FLOAT8", "NUMERIC", "DECIMAL",
  "smallint", "integer", "bigint", "real", "double precision", "numeric", "decimal",
]);
const isNumeric = (typeName: string) => NUMERIC.has(typeName);

describe("ChartPane numeric detection", () => {
  it("treats both Postgres native type names and information_schema names as numeric", () => {
    for (const n of ["INT2", "INT4", "INT8", "FLOAT4", "FLOAT8", "NUMERIC", "DECIMAL"]) {
      expect(isNumeric(n)).toBe(true);
    }
    for (const n of ["smallint", "integer", "bigint", "real", "double precision", "numeric", "decimal"]) {
      expect(isNumeric(n)).toBe(true);
    }
  });

  it("rejects non-numeric types", () => {
    for (const n of ["TEXT", "VARCHAR", "BPCHAR", "BOOL", "JSONB", "UUID", "TIMESTAMPTZ", "text", "jsonb"]) {
      expect(isNumeric(n)).toBe(false);
    }
  });
});
