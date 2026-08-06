import type { ConnectionInput } from "@/ipc/types";

/** Build a mongodb:// URI from the current form values. As with the Postgres
 *  builder, the password is omitted from the *display* string (Test/Connect
 *  still uses the password field) — showing a pasted password back is a smell.
 *
 *  Own module so ConnectionForm.tsx keeps exporting only components (React Fast
 *  Refresh) and the parse/build round-trip stays unit-testable. */
export function buildMongoUri(v: ConnectionInput): string {
  const user = encodeURIComponent(v.username || "");
  const host = v.host || "";
  const port = v.port || 27017;
  const db = v.database ? `/${encodeURIComponent(v.database)}` : "";
  const params: string[] = [];
  // ssl_mode is reused as a generic TLS toggle for Mongo: anything other than
  // "disable" means TLS on (mirrors the driver, which treats non-disable as TLS).
  if (v.ssl_mode && v.ssl_mode !== "disable") params.push("tls=true");
  const q = params.length ? `?${params.join("&")}` : "";
  return `mongodb://${user}${user ? "@" : ""}${host}:${port}${db}${q}`;
}

/** Parse a mongodb:// or mongodb+srv:// URI into a partial input. Returns null
 *  when the string isn't a recognisable Mongo URI so the caller can show a
 *  "couldn't parse" hint rather than silently blanking the form.
 *
 *  Notes:
 *  - mongodb+srv:// (Atlas) has no port in the URI (SRV resolves it); we leave
 *    the port as-is and turn TLS on (srv implies TLS).
 *  - A comma-separated replica-set host list keeps only the first host for the
 *    form's single host/port fields. */
export function parseMongoUri(raw: string): Partial<ConnectionInput> | null {
  const s = raw.trim();
  if (!s) return null;
  const srv = /^mongodb\+srv:\/\//i.test(s);
  if (!srv && !/^mongodb:\/\//i.test(s)) return null;

  // The WHATWG URL parser doesn't accept mongodb+srv and struggles with
  // comma-separated hosts, so normalize to a single-host http URL for parsing
  // while remembering the original scheme.
  const withoutScheme = s.replace(/^mongodb(\+srv)?:\/\//i, "");
  // Split "user:pass@host1,host2:port/db?params" → auth part / rest.
  const at = withoutScheme.lastIndexOf("@");
  const auth = at >= 0 ? withoutScheme.slice(0, at) : "";
  const rest = at >= 0 ? withoutScheme.slice(at + 1) : withoutScheme;

  // rest = "host1[,host2…][:port]/db?params"
  const slash = rest.indexOf("/");
  const q = rest.indexOf("?");
  const hostEnd = slash >= 0 ? slash : q >= 0 ? q : rest.length;
  const hostsPart = rest.slice(0, hostEnd);
  const firstHost = hostsPart.split(",")[0]; // "host[:port]"

  const out: Partial<ConnectionInput> = {};

  // host + port
  const hp = firstHost.split(":");
  if (hp[0]) out.host = hp[0];
  if (!srv && hp[1]) out.port = parseInt(hp[1], 10) || 27017;

  // auth
  if (auth) {
    const [user, pass] = auth.split(":");
    if (user) out.username = decodeURIComponent(user);
    if (pass) out.password = decodeURIComponent(pass);
  }

  // database (path after the host list)
  if (slash >= 0) {
    const afterSlash = rest.slice(slash + 1);
    const db = (q >= 0 ? afterSlash.slice(0, q - slash - 1) : afterSlash).split("?")[0];
    if (db) out.database = decodeURIComponent(db);
  }

  // TLS: srv implies TLS; otherwise honor tls/ssl=true in the query.
  const query = q >= 0 ? rest.slice(q + 1) : "";
  const params = new URLSearchParams(query);
  const tls = srv || params.get("tls") === "true" || params.get("ssl") === "true";
  out.ssl_mode = tls ? "require" : "disable";

  return out;
}
