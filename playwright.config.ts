import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// e2e: the real API and a production build of the web in real-API mode, on a throwaway database and upload
// dir, on their own ports so the dev servers on 3100 / 4100 keep running untouched.
const WEB = 3301;
const API = 4301;
// the same web in `next dev`, only for e2e/console.spec.ts: React throws on mistakes in development that a production build hides
const WEB_DEV = 3302;
const hosts = (p: number) => [`127.0.0.1:${p}`, `localhost:${p}`];

const api = {
  PORT: String(API),
  DATABASE_URL: "postgres://dct:dct@localhost:5434/dct_finance_e2e",
  UPLOAD_DIR: path.join(os.tmpdir(), "dct-e2e-uploads"),
  // The web proxy forwards the browser's Host and Origin, which are the e2e web port's.
  ALLOWED_HOSTS: [...hosts(API), ...hosts(WEB), ...hosts(WEB_DEV)].join(","),
  ALLOWED_ORIGINS: [...hosts(WEB), ...hosts(WEB_DEV)].map((h) => `http://${h}`).join(","),
  // blank, so an e2e run can never spend money on a real model
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
};

export default defineConfig({
  testDir: "e2e",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${WEB}`, channel: process.env.PW_CHANNEL ?? "chrome", headless: true, actionTimeout: 15_000, trace: "retain-on-failure" },
  projects: [
    { name: "production", testIgnore: /console\.spec\.ts/ },
    // dev compiles each route on its first visit, so allow longer waits
    { name: "development", testMatch: /console\.spec\.ts/, expect: { timeout: 60_000 }, use: { baseURL: `http://127.0.0.1:${WEB_DEV}`, actionTimeout: 60_000 } },
  ],
  webServer: [
    {
      // the production build (node dist/server.js), as it ships; ready once its database and jobs are
      command: "pnpm --filter @dct/api exec tsx scripts/e2e-reset.ts && pnpm --filter @dct/api exec tsx scripts/e2e-seed.ts && pnpm --filter @dct/api build && pnpm --filter @dct/api start",
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
    {
      command: `pnpm --filter web exec next dev -H 127.0.0.1 -p ${WEB_DEV}`,
      url: `http://127.0.0.1:${WEB_DEV}`,
      env: { E2E: "dev", API_URL: `http://127.0.0.1:${API}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
