/**
 * "Install on Quit" support.
 *
 * Tauri's updater applies a downloaded package from the *frontend* — there is
 * no Rust-side "apply on exit" hook we can hand the package to. So deferring
 * the install means holding the already-downloaded `Update` handle in memory
 * and calling `install()` ourselves as the window is closing.
 *
 * The consequence is that a deferred install only survives an in-app quit
 * (Cmd-Q, closing the window, File → Quit) — the handle dies with the process,
 * so a force-quit or a crash loses it. That's acceptable: the package stays in
 * the updater's cache, and the next launch's check finds the same version
 * again. It just means "Install on Quit" is best-effort, not a guarantee.
 *
 * Kept in its own module (rather than a ref inside UpdateDialog) so the
 * close-handler in App can reach it without a prop drill or a store round-trip.
 */

/** Minimal shape we need — mirrors the plugin's Update, kept structural so
 *  this module doesn't import `@tauri-apps/plugin-updater` and drag it into
 *  the browser bundle. */
export interface InstallableUpdate {
  version: string;
  install: () => Promise<void>;
}

let pending: InstallableUpdate | null = null;

/** Stage an already-downloaded update to be applied when the app quits. */
export function setPendingInstall(update: InstallableUpdate | null): void {
  pending = update;
}

/** The staged update, if the user chose "Install on Quit". */
export function getPendingInstall(): InstallableUpdate | null {
  return pending;
}

/**
 * Apply a staged update, if there is one. Called from the window-close path.
 *
 * Never throws: a failed install must not trap the user in an app they're
 * trying to close. On failure we simply let the quit proceed — the download
 * is still cached, so the next launch re-offers the same version.
 *
 * Returns true if an install actually ran.
 */
export async function runPendingInstall(): Promise<boolean> {
  const update = pending;
  if (!update) return false;
  // Clear first, so a second close event can't double-install.
  pending = null;
  try {
    await update.install();
    return true;
  } catch {
    return false;
  }
}
