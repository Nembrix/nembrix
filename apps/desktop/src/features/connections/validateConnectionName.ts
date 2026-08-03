import type { ConnectionRecord } from "@/ipc/types";

/** Validate a connection name against the existing set. Required, and
 *  unique case-insensitively across all connections except the one being
 *  edited (matched by id). Returns a user-facing message or null. Pure so
 *  it can be unit-tested without mounting the form.
 *
 *  Lives in its own module (not ConnectionForm.tsx) so the component file
 *  only exports components — required for React Fast Refresh. */
export function validateConnectionName(
  name: string,
  existing: Pick<ConnectionRecord, "id" | "name">[],
  currentId: string | null,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required.";
  const clash = existing.some(
    (c) => c.id !== currentId && c.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (clash) return "A connection with this name already exists.";
  return null;
}
