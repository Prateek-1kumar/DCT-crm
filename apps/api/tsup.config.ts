import { defineConfig } from "tsup";

// @dct/shared and @dct/extraction ship TypeScript source, so bundle it in; everything else stays in node_modules.
export default defineConfig({
  entry: ["src/server.ts", "src/db/migrate.ts"],
  format: "esm",
  target: "node22",
  noExternal: ["@dct/shared", "@dct/extraction"],
  clean: true,
});
