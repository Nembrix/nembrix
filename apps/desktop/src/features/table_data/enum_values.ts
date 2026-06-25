/**
 * Fetch the allowed labels for a Postgres enum type.
 *
 * We cache results per `connectionId:typeName` for the lifetime of the
 * page, since enum membership rarely changes mid-session. If the user
 * later adds a value via ALTER TYPE … ADD VALUE …, they can manually
 * refresh schema (⌘R) to clear by-implication — but we don't try to
 * keep this cache reactive; that's overkill for the use case.
 *
 * Returns null for non-enum types so the caller can fall back to a
 * free-text input.
 */

import * as api from "@/ipc/commands";

const cache = new Map<string, string[] | null>();

function key(connId: string, typeName: string) {
  return `${connId}:${typeName}`;
}

/** Strip array suffix and parameter list from a Postgres type name so
 *  we can look up the underlying enum. e.g. `mood[]` → `mood`,
 *  `varchar(255)` → `varchar` (not an enum, fine). */
function basename(typeName: string): string {
  return typeName.replace(/\[\]$/, "").replace(/\(.+\)$/, "").trim();
}

export async function enumValuesFor(
  connId: string,
  typeName: string,
): Promise<string[] | null> {
  const t = basename(typeName);
  const k = key(connId, t);
  if (cache.has(k)) return cache.get(k) ?? null;

  const labels: string[] = [];
  let isEnum = false;

  // `pg_type.typtype = 'e'` flags enums. We join pg_enum directly so a
  // non-enum type yields zero rows (and we mark it as such).
  const sql = `
    SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = $$${t.replace(/\$/g, "")}$$
     ORDER BY e.enumsortorder;
  `;
  // We use dollar-quoting around the type name rather than a bound
  // parameter because api.execute/api.stream don't expose params today.
  // The replace strips any $ to keep the dollar-quote intact.

  try {
    await new Promise<void>((res, rej) => {
      api.stream(connId, sql, (b) => {
        if (b.columns) isEnum = true;
        for (const row of b.rows) {
          const v = row[0];
          if (v.kind === "text") labels.push(v.value);
          else if (v.kind === "raw") labels.push(v.value);
        }
        if (b.done) res();
      }).catch(rej);
    });
  } catch {
    cache.set(k, null);
    return null;
  }

  const result = labels.length > 0 ? labels : (isEnum ? [] : null);
  cache.set(k, result);
  return result;
}

/** Drop the cached entry for a single type — call after ALTER TYPE. */
export function clearEnumCache(connId: string, typeName: string): void {
  cache.delete(key(connId, basename(typeName)));
}
