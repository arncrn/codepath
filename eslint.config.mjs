import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const javascript = ["**/*.{js,mjs,cjs,jsx}"];
const typescript = ["**/*.{ts,tsx,mts,cts}"];
const unused = { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" };

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.cache/**",
      "**/.codepaths/**",
      "**/.husky/**",
      "**/coverage/**",
      "**/vendor/**",
      "**/build/**",
    ],
  },
  { ...js.configs.recommended, files: javascript },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescript,
  })),
  {
    files: [...javascript, ...typescript],
    languageOptions: {
      ecmaVersion: "latest",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Cleanup and stale-connection probes deliberately ignore some failures.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: javascript,
    rules: { "no-unused-vars": ["error", unused] },
  },
  {
    files: javascript,
    ignores: ["examples/checkout/web/**"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["examples/checkout/web/**/*.{js,jsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      "scripts/test-vscode.mjs",
      "scripts/test-browser.mjs",
      "scripts/test-ui-refactor.mjs",
    ],
    // Playwright evaluates these callbacks in the webview, not in Node.
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        requestAnimationFrame: "readonly",
      },
    },
  },
  {
    files: typescript,
    rules: { "@typescript-eslint/no-unused-vars": ["error", unused] },
  },
  {
    files: ["ui.tsx"],
    rules: {
      "max-lines": [
        "error",
        { max: 20, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["examples/checkout/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      // Demo instrumentation currently accepts untyped JSON snapshots. This is
      // separate from strict checking of Codepath's own application modules.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
