import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { type App, type Built, testApp } from "./helpers.js";

// Production basics: probes, settings checked at startup, request ids.

let app: App;
let built: Built;
beforeAll(async () => {
  built = await testApp({ workers: false });
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
    const other = await testApp({ workers: false });
    await other.ctx.boss.stop({ graceful: false, close: false });
    const res = await other.app.inject({ url: "/readyz" });
    expect([res.statusCode, res.json().jobs]).toEqual([503, "stopped"]);
    await other.app.close();
  });
});

describe("every response carries its request id", () => {
  it("as x-request-id, the same as a server error's ref", async () => {
    await built.ctx.db.execute(sql`ALTER TABLE settings RENAME TO settings_away`);
    try {
      const res = await app.inject({ url: "/api/v1/settings" });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toContain(`(ref ${res.headers["x-request-id"]})`);
      expect(String(res.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await built.ctx.db.execute(sql`ALTER TABLE settings_away RENAME TO settings`);
    }
  });
});

describe("settings, checked at startup", () => {
  const base = { DATABASE_URL: "postgres://dct:dct@localhost:5434/dct_finance_test", EXTRACTION_FAKE: "1" };
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
    expect(c).toMatchObject({ port: 4100, logLevel: "info", listenHost: "127.0.0.1", extractionFake: true, db: { max: 10, statementTimeoutMs: 30_000, lockTimeoutMs: 10_000 } });
    expect(c.allowedHosts).toEqual(["localhost:4100", "127.0.0.1:4100", "localhost:3100", "127.0.0.1:3100"]);
  });

  it("names every bad setting and what it must be, never its value", () => {
    const secret = "s3cr3t-pa55";
    const msg = problems({ DATABASE_URL: `mysql://dct:${secret}@db/x`, PORT: "eighty", UPLOAD_DIR: "data/uploads", LOG_LEVEL: "loud", EXTRACTION_MAX_USD: "2O", ANTHROPIC_API_KEY: "" });
    expect(msg).toContain("- DATABASE_URL must be a postgres:// connection URL");
    expect(msg).toContain("- PORT must be a port number from 1 to 65535");
    expect(msg).toContain("- UPLOAD_DIR must be an absolute path");
    expect(msg).toContain("- LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent");
    expect(msg).toContain("- EXTRACTION_MAX_USD must be a number of dollars above 0");
    expect(msg).toContain("- ANTHROPIC_API_KEY is needed to read contracts (or set EXTRACTION_FAKE=1 for the synthetic reading)");
    for (const value of [secret, "mysql", "eighty", "loud", "2O"]) expect(msg).not.toContain(value);
  });

  it("an OpenAI cross-read needs its key and model, and a price as two numbers", () => {
    const msg = problems({ ...base, CROSS_READ: "OpenAI", OPENAI_PRICE_PER_MTOK: "$2/$10" });
    expect(msg).toContain("- OPENAI_API_KEY is needed when CROSS_READ=openai");
    expect(msg).toContain("- OPENAI_MODEL is needed when CROSS_READ=openai");
    expect(msg).toContain('- OPENAI_PRICE_PER_MTOK must be "input,output" dollars per million tokens');
    expect(problems({ ...base, CROSS_READ: "haiku", OPENAI_PRICE_PER_MTOK: "anything" })).toBeNull(); // unused then
  });
});
