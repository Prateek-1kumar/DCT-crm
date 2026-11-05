import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://dct:dct@localhost:5434/dct_finance_test",
      // fastify.inject sends Host: localhost:80
      ALLOWED_HOSTS: "localhost:80,127.0.0.1:4100",
      // blank, so a developer's .env can never put a real key in a test (tests use fakes)
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENAI_MODEL: "",
      OPENAI_PRICE_PER_MTOK: "",
      UPLOAD_DIR: path.join(os.tmpdir(), `dct-api-test-${process.pid}`),
    },
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false, // one shared test database
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
