// Hand-authored mirror of the Rust types. specta will regenerate
// `bindings/commands.ts` on first dev build; until then we use these.

export type QueryLang = "sql" | "mongo_shell" | "redis_cmd";

export type CellValue =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "text"; value: string }
  | { kind: "raw"; value: string }
  | { kind: "document"; value: unknown }
  | { kind: "bytes"; value: number[] };

export interface ColMeta {
  name: string;
  type_name: string;
  nullable: boolean;
}

export interface RowBatch {
  columns: ColMeta[] | null;
  rows: CellValue[][];
  done: boolean;
}

export interface ExecSummary {
  rows_affected: number;
  last_insert_id: number | null;
  elapsed_ms: number;
}

export interface ColumnNode {
  name: string;
  type_name: string;
  nullable: boolean;
  default: string | null;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  referenced_schema: string;
  referenced_table: string;
  referenced_columns: string[];
}

export interface IndexNode {
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
  method: string;
  definition: string;
}

export interface RelationNode {
  name: string;
  columns: ColumnNode[];
  primary_key: string[];
  foreign_keys: ForeignKey[];
  indexes: IndexNode[];
}

export interface FunctionNode {
  name: string;
  return_type: string;
  argument_types: string[];
}

export interface SchemaNode {
  name: string;
  tables: RelationNode[];
  views: RelationNode[];
  functions: FunctionNode[];
}

export interface DatabaseNode {
  name: string;
  schemas: SchemaNode[];
}

export interface SchemaTree {
  databases: DatabaseNode[];
}

export interface SshInput {
  host: string;
  port: number;
  user: string;
  auth_kind: "password" | "key_file" | "agent";
  password: string | null;
  /** Path to the private key on disk. Picked via Tauri file dialog. */
  key_path: string | null;
  /** Inline key contents (browser mode). Rust writes it to a temp file
   *  before handing the path to russh. */
  key_data: string | null;
  key_passphrase: string | null;
  strict_host_key: boolean;
}

export interface ConnectionInput {
  id: string | null;
  name: string;
  engine: "postgres";
  host: string;
  port: number;
  username: string;
  password: string | null;
  database: string | null;
  ssl_mode: "disable" | "prefer" | "require";
  ssh: SshInput | null;
  color: string | null;
  environment?: Environment;
  /** Optional group label — connections with the same string land in the
   *  same collapsible section in the manager dialog. Free-form so users
   *  can organize by project, region, team, whatever. */
  group?: string | null;
}

export interface SshRecord {
  host: string;
  port: number;
  user: string;
  auth_kind: string;
  key_path: string | null;
  strict_host_key: boolean;
}

export type Environment = "production" | "staging" | "development" | "test" | "other";

export interface ConnectionRecord {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  username: string;
  database: string | null;
  ssl_mode: string;
  ssh: SshRecord | null;
  /** Hex color (e.g. "#ef4444") that tints the rail ring. Picked from env defaults
   *  unless the user overrode it in the form. */
  color: string | null;
  environment?: Environment;
  group?: string | null;
  created_at: string;
  updated_at: string;
}

export type QueryHandle = string;

export interface HistoryEntry {
  sql: string;
  elapsed_ms: number;
  run_at: string;
}

export interface SavedQuery {
  id: string;
  conn_id: string | null;
  name: string;
  sql: string;
  created_at: string;
  updated_at: string;
}
