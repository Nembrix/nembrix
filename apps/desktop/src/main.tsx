import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// Initialize i18next — side-effect import: detects locale, registers
// resources, hooks react-i18next. Must happen before App mounts so the
// first paint already has the right strings.
import "./i18n";
import { hydrateTabsFromStorage } from "@/store/persist";
import { isTauri } from "@/ipc/commands";

// Restore persisted tabs/sessions into the store BEFORE the first render, so
// the initial paint already shows the user's open tabs instead of flashing the
// empty state for a frame (this ran in an App useEffect before, which fires
// after paint). The background reconnect it kicks off stays async. The rest of
// the app wiring (menu handlers, accelerators, persistence subscription) stays
// in App's effect — only this state restore needs to be pre-render.
hydrateTabsFromStorage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Show the window only AFTER the first frame is painted. The window is created
// hidden (`visible: false` in tauri.conf.json) so the user never sees the empty
// shell "pop" into the populated app — the OS reveals an already-rendered
// window instead of a blank one that fills in. Guarded on Tauri (in browser/dev
// there's no window to show). Two rAFs: the first fires before paint, the second
// after it has landed. Best-effort — a failure just means the window shows via
// the platform default.
if (isTauri) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().show();
        } catch {
          /* best-effort: if showing fails, the window still appears */
        }
      })();
    }),
  );
}
