import type { ConnectionInput } from "@/ipc/types";

/** The single source of truth for per-engine metadata. Every UI surface (the
 *  connection form, the status bar, the table-data query builder, …) reads from
 *  here, so adding a new engine is ONE entry — not a scattered set of `if
 *  engine === "…"` branches. */
export type EngineKey = "postgres" | "mysql" | "sqlite" | "mongo" | "redis";

/** A connection-URL adapter: parse a pasted URL into form fields, build one
 *  back, plus the placeholder + example shown to the user. Engines without one
 *  simply don't offer the URL toggle. */
export type UriAdapter = {
  parse: (raw: string) => Partial<ConnectionInput> | null;
  build: (v: ConnectionInput) => string;
  placeholder: string;
  example: string;
};

export type EngineSpec = {
  key: EngineKey;
  /** Display name, e.g. "PostgreSQL". */
  label: string;
  /** Whether a driver ships today (vs. "Coming soon" in the picker). */
  supported: boolean;
  /** Well-known default port; 0 for file-based engines (SQLite). */
  defaultPort: number;
  /** Placeholder hints for the empty User / Database fields. */
  fieldPlaceholders: { user: string; database: string };
  /** Optional connection-URL adapter (registered lazily to avoid a cycle). */
  uri?: UriAdapter;
  /** Whether this engine speaks TLS/SSL (the form shows an SSL select). */
  hasTls: boolean;
  /** Whether JS scripting mode (db.query) is offered for this engine. */
  scripting: boolean;
};

/** Ordered list — drives the engine picker. URI adapters are attached in
 *  registerUriAdapters() to keep this module free of a cyclic import on the
 *  postgres/mongo URI helpers. */
export const ENGINES: Record<EngineKey, EngineSpec> = {
  postgres: {
    key: "postgres", label: "PostgreSQL", supported: true, defaultPort: 5432,
    fieldPlaceholders: { user: "postgres", database: "postgres" },
    hasTls: true, scripting: true,
  },
  mysql: {
    key: "mysql", label: "MySQL", supported: false, defaultPort: 3306,
    fieldPlaceholders: { user: "root", database: "mysql" },
    hasTls: true, scripting: true,
  },
  sqlite: {
    key: "sqlite", label: "SQLite", supported: false, defaultPort: 0,
    fieldPlaceholders: { user: "", database: "path/to/file.db" },
    hasTls: false, scripting: true,
  },
  mongo: {
    key: "mongo", label: "MongoDB", supported: true, defaultPort: 27017,
    fieldPlaceholders: { user: "(optional)", database: "test" },
    hasTls: true, scripting: true,
  },
  redis: {
    key: "redis", label: "Redis", supported: false, defaultPort: 6379,
    fieldPlaceholders: { user: "(optional)", database: "0" },
    hasTls: true, scripting: false,
  },
};

/** Engine order for the picker. */
export const ENGINE_ORDER: EngineKey[] = ["postgres", "mysql", "sqlite", "mongo", "redis"];

/** Look up a spec by (possibly unknown) engine string. */
export function engineSpec(engine: string | undefined): EngineSpec | undefined {
  return engine ? ENGINES[engine as EngineKey] : undefined;
}

/** Display label for an engine string, falling back to the raw key. */
export function engineLabel(engine: string | undefined): string {
  return engineSpec(engine)?.label ?? (engine || "Database");
}

/** Attach the URI adapters. Called once from ConnectionForm so this registry
 *  doesn't import the URI helpers directly (they import ConnectionInput types
 *  from the same area — keeping registration external avoids any cycle). */
export function registerUriAdapters(adapters: Partial<Record<EngineKey, UriAdapter>>): void {
  for (const key of Object.keys(adapters) as EngineKey[]) {
    ENGINES[key].uri = adapters[key];
  }
}
