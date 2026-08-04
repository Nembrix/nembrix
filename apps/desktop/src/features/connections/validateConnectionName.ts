import type { ConnectionRecord } from "@/ipc/types";

/** Validate a connection name. Only requires that it's non-empty —
 *  duplicate names are allowed (you might keep several connections to the
 *  same host under one label, or just not care). Returns a user-facing
 *  message or null. Pure so it can be unit-tested without mounting the form.
 *
 *  Lives in its own module (not ConnectionForm.tsx) so the component file
 *  only exports components — required for React Fast Refresh. The `existing`
 *  / `currentId` params are kept for call-site compatibility, now unused. */
export function validateConnectionName(
  name: string,
  _existing: Pick<ConnectionRecord, "id" | "name">[],
  _currentId: string | null,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required.";
  return null;
}
