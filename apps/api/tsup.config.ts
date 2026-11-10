import { defineConfig } from "tsup";

// The workspace packages ship TypeScript source, so bundle them in. Everything else @dct/api depends on stays in node_modules.
export default defineConfig({
  entry: ["src/server.ts", "src/db/migrate.ts"],
  format: "esm",
  target: "node22",
  noExternal: ["@dct/shared", "@dct/harness"],
  clean: true,
});
