/**
 * Filter value validation, keyed on Postgres type name.
 *
 * The goal is "did the user clearly type the wrong thing for this column"
 * — NOT "would this query parse." Postgres is permissive; e.g. `'42'`
 * coerces to integer fine. So validators here lean toward false-positives
 * being annoying; we accept anything that's syntactically plausible.
 *
 * Returns null when valid, or a short error string. Operators like
 * `IS NULL` and `IS NOT NULL` skip validation entirely (no value).
 */

import type { FilterChip } from "@/store";

type Validator = (value: string) => string | null;

const NUMERIC: Validator = (v) => {
  if (v.trim() === "") return "value required";
  if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return "expected a number";
  return null;
};

const INTEGER: Validator = (v) => {
  if (v.trim() === "") return "value required";
  if (!/^-?\d+$/.test(v.trim())) return "expected an integer";
  return null;
};

const BOOL: Validator = (v) => {
  if (v.trim() === "") return "value required";
  return /^(t|true|f|false|1|0|y|n|yes|no)$/i.test(v.trim()) ? null : "expected true / false";
};

const UUID: Validator = (v) => {
  if (v.trim() === "") return "value required";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())
    ? null
    : "expected uuid (8-4-4-4-12)";
};

const DATE_LIKE: Validator = (v) => {
  if (v.trim() === "") return "value required";
  // Accept ISO 8601 dates / timestamps. Loose: we trust Postgres to
  // reject anything weirder.
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v.trim())
    ? null
    : "expected YYYY-MM-DD[ HH:MM:SS]";
};

const JSON_LIKE: Validator = (v) => {
  if (v.trim() === "") return "value required";
  try { JSON.parse(v); return null; }
  catch { return "expected valid JSON"; }
};

const NON_EMPTY: Validator = (v) =>
  v.length === 0 ? "value required" : null;

/** Pick a validator for the column's pg type. Returns null for "no
 *  validation" so callers can short-circuit. */
function validatorFor(typeName: string): Validator | null {
  const t = typeName.toLowerCase().replace(/\(.+\)$/, "").trim();
  if (["int2", "int4", "int8", "smallint", "integer", "bigint"].includes(t)) return INTEGER;
  if (["float4", "float8", "real", "double precision", "numeric", "decimal", "money"].includes(t)) return NUMERIC;
  if (["bool", "boolean"].includes(t)) return BOOL;
  if (t === "uuid") return UUID;
  if (["date", "timestamp", "timestamptz", "timestamp with time zone", "timestamp without time zone", "time"].includes(t)) return DATE_LIKE;
  if (["json", "jsonb"].includes(t)) return JSON_LIKE;
  if (["text", "varchar", "char", "bpchar", "citext", "name"].includes(t)) return NON_EMPTY;
  return null;
}

/** Public validator. Returns null when valid, or an error string. */
export function validateFilterValue(
  typeName: string,
  op: FilterChip["op"],
  value: string,
): string | null {
  // Null operators don't take a value.
  if (op === "IS NULL" || op === "IS NOT NULL") return null;
  // LIKE / ILIKE / CONTAINS family accept any non-empty string (literal
  // `%` and `_` are user-controlled in raw mode; substring mode escapes
  // them server-side). Skip type-specific validation since substring
  // matching applies to text-like expressions of any type.
  if (op === "LIKE" || op === "ILIKE"
      || op === "CONTAINS" || op === "NOT CONTAINS"
      || op === "ICONTAINS" || op === "NOT ICONTAINS") {
    return NON_EMPTY(value);
  }
  const v = validatorFor(typeName);
  return v ? v(value) : null;
}
