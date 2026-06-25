import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    // Injected at build time so the About dialog and any debug pane can
    // surface the shipping version without an IPC round-trip.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@bindings": fileURLToPath(new URL("./bindings", import.meta.url)),
    },
    // A transitive dep (@uiw/codemirror-extensions-basic-setup) pulls in its
    // own nested copy of @codemirror/state, so two instances get loaded and
    // CodeMirror's `instanceof` extension checks throw
    // ("Unrecognized extension value… multiple instances of @codemirror/state"),
    // blanking the editor. Force a single instance of the core CM packages.
    dedupe: ["@codemirror/state", "@codemirror/view"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
