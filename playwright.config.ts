import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// e2e: the real API (fake AI only) and a production build of the web in real-API mode, on a throwaway database and upload
// dir, on their own ports so the dev servers on 3100 / 4100 keep running untouched.
const WEB = 3301;
const API = 4301;
const hosts = (p: number) => [`127.0.0.1:${p}`, `localhost:${p}`];

const api = {
  PORT: String(API),
  DATABASE_URL: "postgres://dct:dct@localhost:5434/dct_finance_e2e",
  UPLOAD_DIR: path.join(os.tmpdir(), "dct-e2e-uploads"),
  EXTRACTION_FAKE: "1",
  // The web proxy forwards the browser's Host and Origin, which are the e2e web port's.
  ALLOWED_HOSTS: [...hosts(API), ...hosts(WEB)].join(","),
  ALLOWED_ORIGINS: hosts(WEB).map((h) => `http://${h}`).join(","),
};

export default defineConfig({
  testDir: "e2e",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${WEB}`, channel: process.env.PW_CHANNEL ?? "chrome", headless: true, actionTimeout: 15_000, trace: "retain-on-failure" },
  webServer: [
    {
      // the production build (node dist/server.js), as it ships; ready once its database and jobs are
      command: "pnpm --filter @dct/api exec tsx scripts/e2e-reset.ts && pnpm --filter @dct/api build && pnpm --filter @dct/api start",
      url: `http://127.0.0.1:${API}/readyz`,
      env: api,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // A production build, so the shipped CSP and headers are what's tested. Its own folder (.next-e2e): the API_URL is
      // baked into the proxy at build time, and the dev server's .next stays as it is.
      command: `pnpm --filter web build && pnpm --filter web exec next start -H 127.0.0.1 -p ${WEB}`,
      url: `http://127.0.0.1:${WEB}`,
      env: { E2E: "1", API_URL: `http://127.0.0.1:${API}` },
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
