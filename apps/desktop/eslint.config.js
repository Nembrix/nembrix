import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// ESLint flat config. Scoped to the app + test/script sources; build
// output, generated bindings, and the Rust target dir are ignored.
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "target/**",
      "src-tauri/**",
      "playwright-report/**",
      "test-results/**",
      "src/bindings/**", // generated from Rust (commands.ts etc.)
      "vite.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "scripts/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Downgraded to a warning: this rule flags the common, legitimate
      // pattern of setting loading/error state at the start of a
      // data-fetch effect (this app is a DB client, so most effects do
      // exactly that). Kept visible but non-blocking. The genuine
      // correctness rules (rules-of-hooks, refs, immutability,
      // static-components) remain errors.
      "react-hooks/set-state-in-effect": "warn",
      // Allow intentionally-unused args prefixed with _ (common for
      // event handlers and interface conformance).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
