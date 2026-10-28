import { defineConfig } from "tsup";

// @dct/shared and @dct/extraction ship TypeScript source, so bundle them in, and with them their own dependencies
// (exceljs, the AI SDKs): pnpm doesn't make those resolvable from here. Everything @dct/api depends on stays in node_modules.
// mupdf isn't bundled: it runs only in the worker, which @dct/extraction resolves from its own package (render.ts).
export default defineConfig({
  entry: ["src/server.ts", "src/db/migrate.ts"],
  format: "esm",
  target: "node22",
  noExternal: ["@dct/shared", "@dct/extraction"],
  // a bundled CommonJS dependency (exceljs) calls require() for Node's own modules, which ESM output doesn't have
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  clean: true,
});
