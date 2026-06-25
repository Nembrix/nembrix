/**
 * Parsers for CSV / JSON / JSONL / SQL import.
 *
 * Each returns a uniform `{ columns, rows }` shape so the import pipeline
 * can treat all formats the same downstream. SQL is the odd one out — we
 * don't unify into rows; instead we split into statements that the
 * dialog runs in a transaction.
 *
 * The CSV parser is a 80-line state machine because there's no good way
 * around RFC-4180 properly: quoted fields can contain commas, newlines,
 * and doubled quotes, and the inputs we'll see in the wild include all
 * three. Tests in parse.test.ts cover the corner cases.
 */

export interface CsvDialect {
  delimiter: string;     // typically "," or "\t"
  quote: string;         // typically '"'
  /** When the first row holds column names. */
  header: boolean;
  /** Unquoted cells matching this string are parsed as NULL. Common
   *  choices: "NULL" (TablePlus default), "\\N" (psql COPY default).
   *  Set null to disable NULL detection entirely. */
  nullToken: string | null;
  /** When true, a totally empty unquoted cell is also treated as NULL.
   *  When false (the new default), empty stays as an empty string — so
   *  the empty-vs-null distinction round-trips through CSV. */
  emptyIsNull: boolean;
}

export const DEFAULT_DIALECT: CsvDialect = {
  delimiter: ",",
  quote: '"',
  header: true,
  nullToken: "NULL",
  emptyIsNull: false,
};

export interface ParsedTable {
  columns: string[];
  /** Each cell is a string or null when it matched the nullToken. */
  rows: Array<Array<string | null>>;
}

/* ───────────────────────── CSV ───────────────────────── */

export function parseCsv(input: string, d: CsvDialect = DEFAULT_DIALECT): ParsedTable {
  const rows: Array<Array<string | null>> = [];
  let cur: Array<string | null> = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const QUOTE = d.quote;
  const DELIM = d.delimiter;

  // Normalize CRLF → LF up-front so we don't need three branches per char.
  // This is cheap on the typical file sizes we deal with.
  const src = input.replace(/\r\n/g, "\n");
  const sn = src.length;

  const pushField = () => {
    // Unquoted cells matching the nullToken → null. Quoted "" / "NULL"
    // are always kept as strings so the user can disambiguate.
    if (!inQuotedThisField) {
      if (d.nullToken !== null && field === d.nullToken) { cur.push(null); }
      else if (d.emptyIsNull && field === "") { cur.push(null); }
      else { cur.push(field); }
    } else {
      cur.push(field);
    }
    field = "";
    inQuotedThisField = false;
  };
  const pushRow = () => {
    // Skip purely empty trailing rows.
    if (cur.length === 1 && cur[0] === "") {
      cur = [];
      return;
    }
    rows.push(cur);
    cur = [];
  };
  let inQuotedThisField = false;

  while (i < sn) {
    const c = src[i];
    if (inQuotes) {
      if (c === QUOTE) {
        // Doubled quote inside a quoted field → literal quote.
        if (src[i + 1] === QUOTE) { field += QUOTE; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    // Not in quotes.
    if (c === QUOTE) {
      // Only treated as opening quote at field start; otherwise literal.
      if (field === "") { inQuotes = true; inQuotedThisField = true; i++; continue; }
      field += c; i++; continue;
    }
    if (c === DELIM) { pushField(); i++; continue; }
    if (c === "\n") { pushField(); pushRow(); i++; continue; }
    field += c; i++;
  }
  // Final field/row.
  if (field !== "" || cur.length > 0) { pushField(); pushRow(); }
  let columns: string[];
  if (d.header) {
    const head = rows.shift() ?? [];
    columns = head.map((c) => c ?? "");
  } else {
    const width = rows[0]?.length ?? 0;
    columns = Array.from({ length: width }, (_, k) => `c${k + 1}`);
  }
  return { columns, rows };
}

/* ───────────────────────── JSON / JSONL ───────────────────────── */

/**
 * Parses either a JSON array of objects or a single object.
 * Throws on malformed input — the dialog catches the message and shows it.
 */
export function parseJson(input: string): ParsedTable {
  const parsed = JSON.parse(input);
  return objectsToTable(Array.isArray(parsed) ? parsed : [parsed]);
}

/** One JSON object per line, blank lines ignored. */
export function parseJsonl(input: string): ParsedTable {
  const objs: unknown[] = [];
  for (const line of input.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    objs.push(JSON.parse(t));
  }
  return objectsToTable(objs);
}

function objectsToTable(objs: unknown[]): ParsedTable {
  // Union of all keys, preserving the order they first appear so the
  // import order matches the source's "natural" reading order.
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const o of objs) {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const k of Object.keys(o as Record<string, unknown>)) {
        if (!seen.has(k)) { seen.add(k); columns.push(k); }
      }
    }
  }
  const rows: Array<Array<string | null>> = objs.map((o) => {
    const r = (o ?? {}) as Record<string, unknown>;
    return columns.map((c) => {
      const v = r[c];
      if (v === undefined || v === null) return null;
      if (typeof v === "string") return v;
      // Stringify everything else (numbers, bools, nested objects/arrays).
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  });
  return { columns, rows };
}

/* ───────────────────────── SQL ───────────────────────── */

/**
 * Split a SQL script into individual statements. Aware of:
 *  - single-quoted strings with doubled-quote escaping
 *  - line comments (-- …)
 *  - block comments (/* … * /)
 *  - dollar-quoted strings ($tag$ … $tag$) — handles PL/pgSQL bodies
 *
 * Returns each statement with its trailing semicolon stripped.
 */
export function splitSql(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = input.length;

  // Returns the dollar-quote tag at position p, including the dollars,
  // or null if there isn't one.
  const matchDollarTag = (p: number): string | null => {
    if (input[p] !== "$") return null;
    let j = p + 1;
    while (j < n && /[A-Za-z0-9_]/.test(input[j])) j++;
    if (input[j] === "$") return input.slice(p, j + 1);
    return null;
  };

  while (i < n) {
    const c = input[i];

    // Line comment.
    if (c === "-" && input[i + 1] === "-") {
      while (i < n && input[i] !== "\n") { buf += input[i]; i++; }
      continue;
    }
    // Block comment.
    if (c === "/" && input[i + 1] === "*") {
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) { buf += input[i]; i++; }
      if (i < n) { buf += "*/"; i += 2; }
      continue;
    }
    // Single-quoted string.
    if (c === "'") {
      buf += c; i++;
      while (i < n) {
        if (input[i] === "'" && input[i + 1] === "'") { buf += "''"; i += 2; continue; }
        if (input[i] === "'") { buf += "'"; i++; break; }
        buf += input[i]; i++;
      }
      continue;
    }
    // Dollar-quoted string.
    const tag = matchDollarTag(i);
    if (tag) {
      buf += tag;
      i += tag.length;
      const end = input.indexOf(tag, i);
      if (end < 0) { buf += input.slice(i); i = n; continue; }
      buf += input.slice(i, end + tag.length);
      i = end + tag.length;
      continue;
    }
    if (c === ";") {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = "";
      i++;
      continue;
    }
    buf += c; i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/* ───────────────────────── format detection ───────────────────────── */

export type ImportFormat = "csv" | "json" | "jsonl" | "sql";

export function detectFormat(filename: string, sample: string): ImportFormat {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "json") return "json";
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  if (ext === "sql") return "sql";
  // Heuristics on the content.
  const trimmed = sample.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // Multiple {...}-per-line → JSONL.
    const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
    const allObjects = lines.length > 1 && lines.every((l) => /^\s*\{.*\}\s*$/.test(l));
    return allObjects ? "jsonl" : "json";
  }
  if (/(^|\n)\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|WITH)\b/i.test(sample)) {
    return "sql";
  }
  return "csv";
}
