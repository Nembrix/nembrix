/**
 * Render the update manifest's publish date as something readable.
 *
 * Tauri emits an RFC 3339-ish stamp with a space before the offset
 * ("2026-08-22 14:03:11.123 +00:00:00"), which `Date` won't parse on every
 * engine — so fall back to showing just the date part rather than the string
 * "Invalid Date". Returns null when there's nothing usable to show, letting
 * the caller omit the date entirely.
 *
 * Its own module (not a helper inside UpdateDialog) so it's unit-testable —
 * vitest only collects `.ts`, and importing the .tsx would drag React and the
 * Tauri plugin imports into the test.
 */
export function formatUpdateDate(raw: string): string | null {
  const datePart = raw.slice(0, 10);
  const d = new Date(raw.replace(" ", "T"));
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString(undefined, {
      year: "numeric", month: "long", day: "numeric",
    });
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}
