/**
 * Environment defaults — color, label, and the "is this risky?" predicate
 * used to gate destructive actions.
 *
 * Keep the production red strong enough to be impossible to miss in the rail.
 * If the user picks a custom color in the form we store it as the connection's
 * `color` field; otherwise we synthesize it from the environment on display.
 */

import type { Environment } from "@/ipc/types";

export const ENVIRONMENTS: Environment[] = [
  "production", "staging", "development", "test", "other",
];

export const ENV_LABEL: Record<Environment, string> = {
  production:  "Production",
  staging:     "Staging",
  development: "Development",
  test:        "Test",
  other:       "Other",
};

/** Strong, evocative defaults — chosen to be distinct on the dark theme. */
export const ENV_COLOR: Record<Environment, string> = {
  production:  "#ef4444",  // red
  staging:     "#f59e0b",  // amber
  development: "#3b82f6",  // accent blue
  test:        "#8b5cf6",  // violet
  other:       "#6b7280",  // slate
};

export function colorFor(env: Environment | undefined, override: string | null): string {
  if (override && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(override)) return override;
  return ENV_COLOR[env ?? "other"];
}

/** Production-level environments warrant a "type the name to confirm" guard. */
export function isProtected(env: Environment | undefined): boolean {
  return env === "production" || env === "staging";
}

/** Heuristic: any of these phrases in SQL means "could be a really bad day". */
const DESTRUCTIVE = /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER|GRANT|REVOKE)\b/i;
const HAS_WHERE   = /\bWHERE\b/i;

/** Returns a short reason string if a query is dangerous for this env. */
export function destructiveReason(env: Environment | undefined, sql: string): string | null {
  if (!isProtected(env)) return null;
  if (!DESTRUCTIVE.test(sql)) return null;
  // UPDATE/DELETE without WHERE is the worst case — call it out.
  if (/\b(UPDATE|DELETE)\b/i.test(sql) && !HAS_WHERE.test(sql)) {
    return "UPDATE or DELETE without a WHERE clause";
  }
  if (/\bDROP\b/i.test(sql))     return "DROP statement";
  if (/\bTRUNCATE\b/i.test(sql)) return "TRUNCATE statement";
  if (/\bALTER\b/i.test(sql))    return "ALTER statement";
  if (/\bGRANT\b|\bREVOKE\b/i.test(sql)) return "GRANT/REVOKE statement";
  // UPDATE/DELETE with a WHERE is less catastrophic but still warrants a tap.
  return "destructive statement";
}

/** Redis commands that delete data or reconfigure/stop the server, matched as
 *  the command name at the start of an editor line. */
const REDIS_WIPE = new Set(["FLUSHALL", "FLUSHDB"]);
const REDIS_DESTRUCTIVE = new Set([
  "DEL", "UNLINK", "GETDEL", "HDEL", "LREM", "LTRIM", "SREM", "ZREM",
  "ZREMRANGEBYSCORE", "ZREMRANGEBYRANK", "ZREMRANGEBYLEX", "XDEL", "XTRIM",
  "RENAME", "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT",
  "CONFIG", "SHUTDOWN", "DEBUG", "SCRIPT", "FUNCTION", "SWAPDB", "MIGRATE",
  "EVAL", "EVALSHA", "FCALL",
]);

/** `destructiveReason` for a Redis command buffer (one command per line). */
export function redisDestructiveReason(env: Environment | undefined, text: string): string | null {
  if (!isProtected(env)) return null;
  const names = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"))
    .map((l) => l.split(/\s+/)[0].toUpperCase());
  const wipe = names.find((n) => REDIS_WIPE.has(n));
  if (wipe) return `${wipe} (deletes every key in the database)`;
  const hit = names.find((n) => REDIS_DESTRUCTIVE.has(n));
  return hit ? `${hit} command` : null;
}
