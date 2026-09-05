// Extracted from UpdateDialog so the mapping is unit-testable and the
// component module exports only its component.

/**
 * Turn a raw updater error into something a user can act on.
 *
 * The Tauri updater's messages are written for whoever wired it up, not for
 * whoever is running the app: a network blip surfaces as "Could not fetch a
 * valid release JSON from the remote", which says nothing about what to do.
 * We map the ones we can recognise and keep the original underneath, so a bug
 * report still carries the detail.
 */
export function explainUpdateError(raw: string): { summary: string; detail: string } {
  const e = raw.toLowerCase();
  if (e.includes("release json") || e.includes("could not fetch")) {
    return {
      summary:
        "Couldn't reach the update server. Check your internet connection and try again — " +
        "if it keeps failing, GitHub may be having trouble.",
      detail: raw,
    };
  }
  if (e.includes("signature") || e.includes("pubkey") || e.includes("verify")) {
    return {
      summary:
        "The downloaded update failed its signature check, so it wasn't installed. " +
        "Download the latest release manually rather than retrying.",
      detail: raw,
    };
  }
  if (e.includes("network") || e.includes("timeout") || e.includes("dns") || e.includes("connect")) {
    return {
      summary: "The update download timed out. Check your connection and try again.",
      detail: raw,
    };
  }
  if (e.includes("permission") || e.includes("denied") || e.includes("read-only")) {
    return {
      summary:
        "Nembrix doesn't have permission to install the update. " +
        "If it's running from a read-only location, move it to Applications and retry.",
      detail: raw,
    };
  }
  return { summary: "The update couldn't be completed.", detail: raw };
}
