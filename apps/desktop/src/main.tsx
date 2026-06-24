import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// Initialize i18next — side-effect import: detects locale, registers
// resources, hooks react-i18next. Must happen before App mounts so the
// first paint already has the right strings.
import "./i18n";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
