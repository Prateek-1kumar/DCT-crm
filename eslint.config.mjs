// @ts-check
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// apps/api, packages/shared and packages/extraction (each package's `pnpm lint`; the web has its own config). Only rules
// that catch a silent failure TypeScript lets through, never style: a Drizzle query that isn't awaited is never sent, so
// an un-awaited `audit(tx, …)` writes nothing, and a promise handed where nothing awaits it fails unseen.
export default defineConfig([
  globalIgnores(["apps/web/**", "e2e/**", "**/dist/**", ".claude/**", "test-results/**"]),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      // each file is type-checked with its own package's tsconfig.json
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Drizzle's queries are thenables, not Promises, and the rule checks only Promises unless told to. A Fastify reply
      // is a thenable too (awaiting it waits for the response to be sent); its chained calls (`reply.header(…)`) do
      // their work at once, so leaving one unawaited loses nothing.
      "@typescript-eslint/no-floating-promises": ["error", { checkThenables: true, allowForKnownSafePromises: [{ from: "package", package: "fastify", name: "FastifyReply" }] }],
      "@typescript-eslint/no-misused-promises": "error",
      // `return promise` inside try/catch/finally leaves the handler before the promise settles: the catch never sees
      // its error, and a finally runs (removing an upload's staged files, say) while it's still running
      "@typescript-eslint/return-await": ["error", "error-handling-correctness-only"],
    },
  },
]);
