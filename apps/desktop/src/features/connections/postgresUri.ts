import type { ConnectionInput } from "@/ipc/types";

/** Build a libpq-style URI from the current form values. The password
 *  is intentionally omitted from the *display* string (Test/Connect
 *  still uses the password field) — pasted URIs include passwords, but
 *  rendering them back in a visible field is a security smell.
 *
 *  Extracted to its own module so ConnectionForm.tsx only exports
 *  components (React Fast Refresh) and so the parse/build round-trip is
 *  unit-testable. */
export function buildPostgresUri(v: ConnectionInput): string {
  const user = encodeURIComponent(v.username || "");
  const host = v.host || "";
  const port = v.port || 5432;
  const db = v.database ? `/${encodeURIComponent(v.database)}` : "";
  const params: string[] = [];
  if (v.ssl_mode && v.ssl_mode !== "prefer") params.push(`sslmode=${v.ssl_mode}`);
  const q = params.length ? `?${params.join("&")}` : "";
  return `postgresql://${user}${user ? "@" : ""}${host}:${port}${db}${q}`;
}

/** Parse a postgres:// or postgresql:// URI into a partial input.
 *  Returns null when the string isn't a recognisable Postgres URI so
 *  the caller can show a "couldn't parse" hint rather than silently
 *  blanking the form. */
export function parsePostgresUri(raw: string): Partial<ConnectionInput> | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^postgres(ql)?:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const out: Partial<ConnectionInput> = {};
  if (u.hostname) out.host = u.hostname;
  if (u.port) out.port = parseInt(u.port, 10) || 5432;
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  const path = u.pathname.replace(/^\//, "");
  if (path) out.database = decodeURIComponent(path);
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode === "disable" || sslmode === "prefer" || sslmode === "require") {
    out.ssl_mode = sslmode;
  }
  return out;
}
