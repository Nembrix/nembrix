import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// Initialize i18next — side-effect import: detects locale, registers
// resources, hooks react-i18next. Must happen before App mounts so the
// first paint already has the right strings.
import "./i18n";
import { hydrateTabsFromStorage } from "@/store/persist";

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
