import { sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoss } from "../src/boss.js";
import { ConfigError, config, parseConfig } from "../src/config.js";
import { apiPoolOptions, createDb } from "../src/db/index.js";
import { type App, type Built, testApp } from "./helpers.js";

// Production basics: probes, settings checked at startup, the jobs queue, the pool's limits.

let app: App;
let built: Built;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());

describe("probes", () => {
  it("live and ready, outside /api/v1, behind the host guard", async () => {
    expect((await app.inject({ url: "/livez" })).json()).toEqual({ status: "ok" });
    const ready = await app.inject({ url: "/readyz" });
    expect([ready.statusCode, ready.json()]).toEqual([200, { status: "ready", database: "ok", jobs: "ok", schema: "ok" }]);
    expect(ready.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ url: "/readyz", headers: { host: "evil.example:4100" } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/v1/readyz" })).statusCode).toBe(404);
  });

  it("not ready while the database is behind this build's migrations", async () => {
    const last = sql`(SELECT max(id) FROM drizzle.__drizzle_migrations)`;
    await built.ctx.db.execute(sql`UPDATE drizzle.__drizzle_migrations SET created_at = created_at - 1 WHERE id = ${last}`);
    try {
      const res = await app.inject({ url: "/readyz" });
      expect([res.statusCode, res.json()]).toEqual([503, { status: "not ready", database: "ok", jobs: "ok", schema: "behind" }]);
    } finally {
      await built.ctx.db.execute(sql`UPDATE drizzle.__drizzle_migrations SET created_at = created_at + 1 WHERE id = ${last}`);
    }
  });

  it("not ready once the jobs have stopped (shutting down)", async () => {
    const other = await testApp();
    await other.ctx.boss.stop({ graceful: false, close: false });
    const res = await other.app.inject({ url: "/readyz" });
    expect([res.statusCode, res.json().jobs]).toEqual([503, "stopped"]);
    await other.app.close();
  });
});

describe("the jobs queue", () => {
  it("starts with no queues of its own and no workers", async () => {
    const quiet = () => {};
    const boss = await startBoss({ log: { error: quiet, warn: quiet } as unknown as Parameters<typeof startBoss>[0]["log"] });
    try {
      // pg-boss keeps an internal queue of its own, named __pgboss__…; "read" and "ocr" are the app's jobs, created and kept by the app
      expect((await boss.getQueues()).filter((q) => !q.name.startsWith("__pgboss__") && q.name !== "read" && q.name !== "ocr")).toEqual([]);
      expect(boss.getWipData()).toEqual([]);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});

describe("the pool's limits", () => {
  it("every connection gets the statement and lock timeouts from the settings", async () => {
    const { db, pool } = createDb(config.databaseUrl, apiPoolOptions());
    try {
      const { rows } = await db.execute<{ s: string; l: string }>(sql`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`);
      expect(rows[0]).toEqual({ s: "30s", l: "10s" });
    } finally {
      await pool.end();
    }
  });
});

describe("settings, checked at startup", () => {
  const base = { DATABASE_URL: "postgres://dct:dct@localhost:5434/dct_finance_test" };
  const problems = (env: Record<string, string>) => {
    try {
      parseConfig(env);
    } catch (e) {
      if (e instanceof ConfigError) return e.message;
      throw e;
    }
    return null;
  };

  it("defaults the rest; an empty value counts as unset", () => {
    const c = parseConfig({ ...base, PORT: "" });
    expect(c).toMatchObject({
      port: 4100,
      logLevel: "info",
      listenHost: "127.0.0.1",
      db: { max: 10, statementTimeoutMs: 30_000, lockTimeoutMs: 10_000 },
      requestTimeoutMs: 120_000,
      keepAliveTimeoutMs: 72_000,
      shutdownTimeoutMs: 30_000,
    });
    expect(c.allowedHosts).toEqual(["localhost:4100", "127.0.0.1:4100", "localhost:3100", "127.0.0.1:3100"]);
  });

  it("names every bad setting and what it must be, never its value", () => {
    const secret = "s3cr3t-pa55";
    const msg = problems({ DATABASE_URL: `mysql://dct:${secret}@db/x`, PORT: "eighty", UPLOAD_DIR: "data/uploads", LOG_LEVEL: "loud", REQUEST_TIMEOUT_MS: "5" });
    expect(msg).toContain("- DATABASE_URL must be a postgres:// connection URL");
    expect(msg).toContain("- PORT must be a port number from 1 to 65535");
    expect(msg).toContain("- UPLOAD_DIR must be an absolute path");
    expect(msg).toContain("- LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent");
    expect(msg).toContain("- REQUEST_TIMEOUT_MS must be a number of milliseconds from 1000 to 3600000");
    for (const value of [secret, "mysql", "eighty", "loud"]) expect(msg).not.toContain(value);
  });

  it("needs no AI key to start; the migrator never does either", async () => {
    expect(problems(base)).toBeNull();
    const api = path.resolve(import.meta.dirname, "..");
    // set but empty, so .env can't fill them in
    const { stdout } = await promisify(execFile)(path.join(api, "node_modules/.bin/tsx"), ["src/db/migrate.ts"], {
      cwd: api,
      env: { ...process.env, DATABASE_URL: base.DATABASE_URL, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
    });
    expect(stdout).toContain("migrations applied");
  });
});
