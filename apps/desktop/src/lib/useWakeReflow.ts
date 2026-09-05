/**
 * Force the webview to re-measure the layout after the machine wakes from
 * sleep.
 *
 * ## The symptom
 *
 * After a macOS sleep/wake cycle the app comes back with the window chrome and
 * sidebar drawn correctly, but the editor pane consuming the full height —
 * pushing the toolbar, results grid and console off-screen. The panes are still
 * mounted (React state is untouched, the View menu still reports the results
 * pane as visible); they simply are not where they should be.
 *
 * ## Why this is a workaround, not a fix
 *
 * The usual culprits were ruled out before writing this:
 *
 *   - Not the ⌘2 panel toggle — the View menu showed the item still ticked.
 *   - Not a missing `min-height: 0` — adding one changed nothing under test.
 *   - Not `height: 100vh` collapsing — simulating a viewport collapse and
 *     restore (720 → 1 → 720) reflows correctly.
 *   - Not React unmounting the tab — the editor renders with its content.
 *
 * The deciding datum: **resizing the window does not fix it**. A resize forces
 * a full reflow, so if the DOM and CSS were sound the layout would recover.
 * That points below the DOM, at the WKWebView surface being resumed stale —
 * which we can't fix from here, only prod.
 *
 * So this reads a layout property to force synchronous measurement, then
 * nudges a real style value for one frame so the compositor cannot coalesce
 * the change away. It is cheap (a handful of reads on an event that fires
 * rarely) and cannot corrupt state, since it writes nothing that outlives the
 * frame.
 *
 * Remove this once the underlying webview behaviour is understood.
 */

import { useEffect } from "react";

function nudgeLayout(): void {
  const root = document.querySelector<HTMLElement>(".app");
  if (!root) return;

  // Reading a layout property forces the engine to flush pending geometry
  // rather than serve a cached (possibly stale) box.
  void root.offsetHeight;

  // Then perturb a real style and revert it in the SAME synchronous block,
  // with a forced measurement between the two writes. The read is what makes
  // the perturbation observable to the engine, so the pair still triggers a
  // reflow while leaving no residue.
  //
  // Deliberately not requestAnimationFrame for the revert: rAF does not fire
  // while the page is backgrounded, which is exactly when this runs — a wake
  // event can arrive before the compositor resumes, and the style would stay
  // applied indefinitely. A test caught that leaving `padding-bottom: 0.01px`
  // stuck on the root element.
  const previous = root.style.paddingBottom;
  root.style.paddingBottom = "0.01px";
  void root.offsetHeight;
  root.style.paddingBottom = previous;
}

export function useWakeReflow(): void {
  useEffect(() => {
    // `visibilitychange` fires when the display comes back; `focus` covers the
    // case where the window was already frontmost when the machine slept and
    // no visibility transition is reported.
    const onVisible = () => {
      if (document.visibilityState === "visible") nudgeLayout();
    };
    window.addEventListener("focus", nudgeLayout);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", nudgeLayout);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
