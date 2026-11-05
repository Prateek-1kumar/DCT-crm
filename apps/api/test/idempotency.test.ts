import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { idempotencyKeys } from "../src/db/schema.js";
import { multipart, type App, type Built } from "./helpers.js";

let built: Built;
let app: App;
const runs = new Map<string, number>();
const ran = (name: string) => runs.get(name) ?? 0;
const hit = (name: string) => runs.set(name, ran(name) + 1);
let release: () => void = () => {};
let started: () => void = () => {};

beforeAll(async () => {
  built = await buildApp({
    routes: (api) => {
      api.post<{ Params: { name: string } }>("/test/write/:name", async (req, reply) => {
        hit(req.params.name);
        return reply.status(201).send({ run: ran(req.params.name) });
      });
      api.delete("/test/write", async () => ({ ok: true }));
      api.delete("/test/write/:name", async () => ({ ok: true }));
      api.get("/test/read", async () => ({ ok: true }));
      api.post("/test/bad", async () => {
        hit("bad");
        throw new Error("secret");
      });
      api.post("/test/refused", async () => {
        hit("refused");
        return Promise.reject(Object.assign(new Error("No."), { statusCode: 409 }));
      });
      api.post("/test/fails-once", async (req, reply) => {
        hit("fails-once");
        if (ran("fails-once") === 1) throw new Error("boom");
        return reply.send({ run: ran("fails-once") });
      });
      api.post("/test/slow", async () => {
        hit("slow");
        started();
        await new Promise<void>((r) => (release = r));
        return { run: ran("slow") };
      });
      api.post("/test/files", async (req) => {
        hit("files");
        const names: string[] = [];
        for await (const part of req.files()) {
          await part.toBuffer();
          names.push(part.filename);
        }
        return { run: ran("files"), names };
      });
    },
  });
  app = built.app;
});
afterAll(() => app.close());

const key = () => `"${randomUUID()}"`;
const post = (url: string, k?: string, payload: object = {}) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: k ? { "idempotency-key": k } : {}, payload });

describe("idempotency keys", () => {
  it("runs a write once and replays its status and body to a resend", async () => {
    const k = key();
    const first = await post("/test/write/once", k);
    const again = await post("/test/write/once", k);
    expect(first.statusCode).toBe(201);
    expect([again.statusCode, again.json()]).toEqual([201, { run: 1 }]);
    expect(ran("once")).toBe(1);
    const [row] = await built.ctx.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, k.slice(1, -1)));
    expect(row).toMatchObject({ method: "POST", path: "/api/v1/test/write/once", status: 201, body: { run: 1 } });
  });

  it("treats a different key as a different action, and a write without a key as today", async () => {
    await post("/test/write/many", key());
    await post("/test/write/many", key());
    await post("/test/write/many");
    await post("/test/write/many");
    expect(ran("many")).toBe(4);
  });

  it("accepts an unquoted key too", async () => {
    const k = randomUUID();
    await post("/test/write/bare", k);
    await post("/test/write/bare", `"${k}"`);
    expect(ran("bare")).toBe(1);
  });

  it("refuses a key from another method or path in plain words", async () => {
    const k = key();
    await post("/test/write/first", k);
    const other = await post("/test/write/second", k);
    const del = await app.inject({ method: "DELETE", url: "/api/v1/test/write/first", headers: { "idempotency-key": k } });
    expect(other.statusCode).toBe(422);
    expect(other.json().message).toBe("This request's key was already used for a different action. Reload the page and try again.");
    expect(del.statusCode).toBe(422);
    expect(ran("second")).toBe(0);
  });

  it("ignores the query string when comparing paths", async () => {
    const k = key();
    const first = await app.inject({ method: "DELETE", url: "/api/v1/test/write?by=A", headers: { "idempotency-key": k } });
    const again = await app.inject({ method: "DELETE", url: "/api/v1/test/write?by=A", headers: { "idempotency-key": k } });
    expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
  });

  it("is not applied to reads", async () => {
    const k = key();
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "GET", url: "/api/v1/test/read", headers: { "idempotency-key": k } })).statusCode).toBe(200);
    expect(await built.ctx.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, k.slice(1, -1)))).toEqual([]);
  });

  it("rejects a key that is empty or too long", async () => {
    expect((await post("/test/write/bad-key", '""')).statusCode).toBe(400);
    expect((await post("/test/write/bad-key", "k".repeat(201))).statusCode).toBe(400);
    expect(ran("bad-key")).toBe(0);
  });

  it("keeps and replays a 4xx answer", async () => {
    const k = key();
    const first = await post("/test/refused", k);
    const again = await post("/test/refused", k);
    expect([first.statusCode, again.statusCode]).toEqual([409, 409]);
    expect(again.json().message).toBe("No.");
    expect(ran("refused")).toBe(1);
  });

  it("tells a resend that arrives while the first is still running to wait, then replays the first's answer", async () => {
    const k = key();
    const running = new Promise<void>((r) => (started = r));
    const first = post("/test/slow", k);
    await running;
    const early = await post("/test/slow", k);
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toBe("This is already being done. Wait a moment, then reload.");
    release();
    expect((await first).json()).toEqual({ run: 1 });
    const later = await post("/test/slow", k);
    expect(later.json()).toEqual({ run: 1 });
    expect(ran("slow")).toBe(1);
  });

  it("frees the key after a 5xx so the retry runs again", async () => {
    const k = key();
    expect((await post("/test/fails-once", k)).statusCode).toBe(500);
    expect(await built.ctx.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, k.slice(1, -1)))).toEqual([]);
    const retry = await post("/test/fails-once", k);
    expect([retry.statusCode, retry.json()]).toEqual([200, { run: 2 }]);
    expect((await post("/test/fails-once", k)).json()).toEqual({ run: 2 });
    expect(ran("fails-once")).toBe(2);
  });

  it("works for multipart uploads", async () => {
    const k = key();
    const { payload, headers } = await multipart([{ name: "a.pdf", data: Buffer.from("%PDF-1.4") }]);
    const send = () => app.inject({ method: "POST", url: "/api/v1/test/files", headers: { ...headers, "idempotency-key": k }, payload });
    const first = await send();
    const again = await send();
    expect(first.json()).toEqual({ run: 1, names: ["a.pdf"] });
    expect(again.json()).toEqual({ run: 1, names: ["a.pdf"] });
    expect(ran("files")).toBe(1);
  });

  it("removes keys older than a day when a new key is stored", async () => {
    const old = randomUUID();
    const db = built.ctx.db;
    await db.insert(idempotencyKeys).values({ key: old, method: "POST", path: "/x", status: 200, body: {}, createdAt: new Date(Date.now() - 25 * 3600_000) });
    await post("/test/write/sweep", key());
    expect(await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, old))).toEqual([]);
  });
});
