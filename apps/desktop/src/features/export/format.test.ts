import { describe, expect, it } from "vitest";
import {
  DEFAULT_CSV, exportCsv, exportJson, exportRows, exportSqlInsert,
  fileBase, filterColumns, suggestExt,
} from "./format";
import type { CellValue, ColMeta } from "@/ipc/types";

const COLS: ColMeta[] = [
  { name: "id", type_name: "INT4", nullable: false },
  { name: "name", type_name: "TEXT", nullable: false },
  { name: "payload", type_name: "JSONB", nullable: true },
];
const cv = {
  int: (n: number): CellValue => ({ kind: "int", value: n }),
  text: (s: string): CellValue => ({ kind: "text", value: s }),
  json: (v: unknown): CellValue => ({ kind: "document", value: v }),
  nul: (): CellValue => ({ kind: "null" }),
  bytes: (xs: number[]): CellValue => ({ kind: "bytes", value: xs }),
  bool: (b: boolean): CellValue => ({ kind: "bool", value: b }),
};

describe("CSV", () => {
  it("emits a header row by default", () => {
    const out = exportCsv(COLS, [[cv.int(1), cv.text("alice"), cv.json({a: 1})]]);
    expect(out.split("\n")[0]).toBe(`id,name,payload`);
  });

  it("quotes fields that contain the delimiter, quote, CR, or LF", () => {
    const rows: CellValue[][] = [[
      cv.int(1),
      cv.text(`O'Brien, Jr.`),  // contains comma → must be quoted
      cv.text(`line1\nline2`),  // contains newline → must be quoted
    ]];
    const out = exportCsv(
      [
        { name: "id", type_name: "INT4", nullable: false },
        { name: "name", type_name: "TEXT", nullable: false },
        { name: "note", type_name: "TEXT", nullable: false },
      ],
      rows,
      { ...DEFAULT_CSV, header: false },
    );
    expect(out).toContain(`"O'Brien, Jr."`);
    expect(out).toContain(`"line1\nline2"`);
  });

  it("doubles embedded quotes", () => {
    const out = exportCsv(
      [{ name: "x", type_name: "TEXT", nullable: false }],
      [[cv.text(`he said "hi"`)]],
      { ...DEFAULT_CSV, header: false },
    );
    expect(out.trim()).toBe(`"he said ""hi"""`);
  });

  it("renders NULL as the configured token", () => {
    const out = exportCsv(
      [{ name: "x", type_name: "TEXT", nullable: true }],
      [[cv.nul()]],
      { ...DEFAULT_CSV, header: false, nullToken: "\\N" },
    );
    expect(out.trim()).toBe(`\\N`);
  });

  it("renders documents as JSON strings", () => {
    const out = exportCsv(COLS, [[cv.int(1), cv.text("a"), cv.json({k: [1, "x"]})]], { ...DEFAULT_CSV, header: false });
    expect(out.trim()).toBe(`1,a,"{""k"":[1,""x""]}"`);
  });

  it("renders bytes as hex with \\x prefix", () => {
    const out = exportCsv(
      [{ name: "b", type_name: "BYTEA", nullable: false }],
      [[cv.bytes([0xde, 0xad, 0xbe, 0xef])]],
      { ...DEFAULT_CSV, header: false },
    );
    expect(out.trim()).toBe(`\\xdeadbeef`);
  });

  it("uses CRLF when configured", () => {
    const out = exportCsv(
      [{ name: "x", type_name: "TEXT", nullable: false }],
      [[cv.text("a")], [cv.text("b")]],
      { ...DEFAULT_CSV, lineEnding: "\r\n" },
    );
    expect(out).toContain("a\r\nb\r\n");
  });
});

describe("JSON", () => {
  it("array form pairs column names to values", () => {
    const out = exportJson(COLS, [[cv.int(1), cv.text("a"), cv.nul()]]);
    const parsed = JSON.parse(out);
    expect(parsed[0]).toEqual({ id: 1, name: "a", payload: null });
  });

  it("JSONL emits one object per line, no array brackets", () => {
    const out = exportJson(COLS, [
      [cv.int(1), cv.text("a"), cv.nul()],
      [cv.int(2), cv.text("b"), cv.json({k: 1})],
    ], { lines: true, indent: 0 });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, name: "a", payload: null });
    expect(JSON.parse(lines[1])).toEqual({ id: 2, name: "b", payload: { k: 1 } });
  });

  it("inlines document values (no double-stringification)", () => {
    const out = exportJson(COLS, [[cv.int(1), cv.text("a"), cv.json({k: 1})]]);
    const parsed = JSON.parse(out);
    expect(parsed[0].payload).toEqual({ k: 1 });
  });
});

describe("SQL INSERT", () => {
  it("emits a single INSERT for small batches", () => {
    const out = exportSqlInsert(COLS, [
      [cv.int(1), cv.text("alice"), cv.nul()],
      [cv.int(2), cv.text("bob"), cv.json({k: 1})],
    ], { qualifiedTarget: `"public"."users"`, batchSize: 100 });
    expect(out).toMatch(/^INSERT INTO "public"\."users" \("id", "name", "payload"\) VALUES/);
    expect(out).toContain(`(1, 'alice', NULL)`);
    expect(out).toContain(`(2, 'bob', '{"k":1}'::jsonb)`);
    // One INSERT terminated with semicolon.
    expect(out.split(/^INSERT/m)).toHaveLength(2);
  });

  it("splits into multiple INSERT statements when batches overflow", () => {
    const rows: CellValue[][] = Array.from({ length: 5 }, (_, i) => [
      cv.int(i), cv.text(`n${i}`), cv.nul(),
    ]);
    const out = exportSqlInsert(COLS, rows, { qualifiedTarget: `"x"."y"`, batchSize: 2 });
    // ceil(5 / 2) = 3 INSERT statements.
    expect(out.split(/^INSERT/m)).toHaveLength(4);
  });

  it("escapes embedded single quotes", () => {
    const out = exportSqlInsert(
      [{ name: "x", type_name: "TEXT", nullable: false }],
      [[cv.text(`O'Brien`)]],
      { qualifiedTarget: `"a"."b"`, batchSize: 1 },
    );
    expect(out).toContain(`'O''Brien'`);
  });

  it("renders bytes via decode(hex)", () => {
    const out = exportSqlInsert(
      [{ name: "b", type_name: "BYTEA", nullable: false }],
      [[cv.bytes([0x00, 0xff])]],
      { qualifiedTarget: `"a"."b"`, batchSize: 1 },
    );
    expect(out).toContain(`decode('00ff', 'hex')`);
  });

  it("returns a no-rows comment for empty input rather than malformed SQL", () => {
    const out = exportSqlInsert(COLS, [], { qualifiedTarget: `"a"."b"`, batchSize: 100 });
    expect(out).toContain("no rows");
    expect(out).not.toContain("INSERT");
  });
});

describe("filterColumns", () => {
  it("returns all when include is null", () => {
    const { cols, rows } = filterColumns(COLS, [[cv.int(1), cv.text("a"), cv.nul()]], null);
    expect(cols).toEqual(COLS);
    expect(rows[0].length).toBe(3);
  });

  it("drops columns not in the allow list and aligns row data", () => {
    const { cols, rows } = filterColumns(COLS,
      [[cv.int(1), cv.text("a"), cv.json({k: 1})]],
      ["id", "payload"],
    );
    expect(cols.map((c) => c.name)).toEqual(["id", "payload"]);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0][0]).toEqual({ kind: "int", value: 1 });
    expect(rows[0][1]).toEqual({ kind: "document", value: { k: 1 } });
  });
});

describe("exportRows orchestrator", () => {
  it("dispatches to the chosen format", () => {
    const rows = [[cv.int(1), cv.text("a"), cv.nul()]];
    expect(exportRows({ format: "csv", columns: COLS, rows })).toContain("id,name,payload");
    expect(exportRows({ format: "json", columns: COLS, rows })).toContain(`"name": "a"`);
    const jsonl = exportRows({ format: "jsonl", columns: COLS, rows });
    expect(jsonl.split("\n").filter(Boolean)).toHaveLength(1);
    expect(exportRows({
      format: "sql", columns: COLS, rows,
      sql: { qualifiedTarget: `"a"."b"` },
    })).toMatch(/INSERT INTO "a"\."b"/);
  });

  it("respects includeColumns for CSV", () => {
    const out = exportRows({
      format: "csv",
      columns: COLS,
      rows: [[cv.int(1), cv.text("a"), cv.nul()]],
      includeColumns: ["name"],
    });
    expect(out.split("\n")[0]).toBe("name");
    expect(out).not.toContain("payload");
  });
});

describe("suggestExt", () => {
  it("maps formats to file extensions", () => {
    expect(suggestExt("csv")).toBe("csv");
    expect(suggestExt("jsonl")).toBe("jsonl");
    expect(suggestExt("sql")).toBe("sql");
  });
});

describe("fileBase", () => {
  it("omits the default public schema", () => {
    expect(fileBase("public", "users")).toBe("users");
  });

  it("keeps a non-default schema so same-named tables don't collide", () => {
    // Exporting `users` from both `public` and `auth` into one folder must
    // produce two files, not one overwriting the other.
    expect(fileBase("auth", "users")).toBe("auth.users");
    expect(fileBase("public", "users")).not.toBe(fileBase("auth", "users"));
  });

  it("leaves the table name untouched", () => {
    expect(fileBase("public", "TypeormMigrations")).toBe("TypeormMigrations");
    expect(fileBase("reporting", "swap_quotes")).toBe("reporting.swap_quotes");
  });
});
