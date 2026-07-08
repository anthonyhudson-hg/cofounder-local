import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "node_modules", "sidecar/dist", "sidecar/node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // This codebase consistently uses `useEffect(() => { reload() }, [deps])` to
      // load/reset data from SQLite on mount and on id changes — a standard,
      // correct data-fetching effect. This rule's static analysis can't tell that
      // apart from the "derive state from props" anti-pattern it's meant to catch,
      // so it fires on nearly every data hook. Kept as a warning rather than off
      // so genuinely new anti-patterns still get flagged for review.
      "react-hooks/set-state-in-effect": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The sidecar previously had ZERO static-analysis coverage at all — the code
    // that spawns subprocesses, holds API keys via the OS keychain, and owns the
    // SQLite DB (report §6/Part 6). Reuses this project's already-installed
    // eslint/typescript-eslint tooling rather than adding a second toolchain in
    // sidecar/, since sidecar isn't an npm workspace of the root. A separate
    // Node/CommonJS subproject: Node globals, no React plugins, no browser globals.
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["sidecar/src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // The sidecar is CommonJS output and uses a lazy `require()` for the OS
      // keychain binding and the Codex SDK's dynamic-import interop shim — both
      // deliberate, documented patterns, not something to flag.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
