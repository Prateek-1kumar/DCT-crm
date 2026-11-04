import { defineConfig } from "tsup";

// @dct/shared ships TypeScript source, so bundle it in. Everything else @dct/api depends on stays in node_modules.
export default defineConfig({
  entry: ["src/server.ts", "src/db/migrate.ts"],
  format: "esm",
  target: "node22",
  noExternal: ["@dct/shared"],
  clean: true,
});
