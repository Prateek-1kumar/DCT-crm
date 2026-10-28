import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// e2e: real API (fake AI only) + web in real-API mode, on a throwaway database and upload dir.
const env = {
  DATABASE_URL: "postgres://dct:dct@localhost:5434/dct_finance_e2e",
  UPLOAD_DIR: path.join(os.tmpdir(), "dct-e2e-uploads"),
  EXTRACTION_FAKE: "1",
};

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3100", channel: process.env.PW_CHANNEL ?? "chrome", headless: true, trace: "retain-on-failure" },
  webServer: [
    {
      command: "pnpm --filter @dct/api exec tsx scripts/e2e-reset.ts && pnpm --filter @dct/api start",
      url: "http://127.0.0.1:4100/api/v1/settings",
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    { command: "pnpm --filter web dev:api", url: "http://localhost:3100", reuseExistingServer: false, timeout: 120_000 },
  ],
});
