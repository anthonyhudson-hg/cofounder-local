import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `sidecar/` is a separate Node subproject (its own tsconfig/module
  // resolution, runs under Node not the browser) — out of scope here.
  { ignores: ["dist", "src-tauri", "sidecar", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
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
);
