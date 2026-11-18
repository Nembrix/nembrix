import { useStore } from "@/store";
import { engineDialect } from "./engines";
import type { SqlDialect } from "@/lib/sql-dialect";

/** The SQL dialect for a session (or legacy connection) id — for code that
 *  only has the id at hand (dialogs, menu handlers). Resolves session →
 *  connection → engine; unknown falls back to Postgres. */
export function dialectFor(connId: string | null | undefined): SqlDialect {
  if (!connId) return "postgres";
  const s = useStore.getState();
  const connectionId = s.sessions.find((x) => x.id === connId)?.connectionId ?? connId;
  return engineDialect(s.connections.find((c) => c.id === connectionId)?.engine);
}
