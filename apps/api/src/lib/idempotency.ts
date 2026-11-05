import { eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { idempotencyKeys } from "../db/schema.js";
import { HttpError } from "./http.js";

const KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_KEY = 200;

/**
 * Applies each write once per `Idempotency-Key`: the first request runs and its answer is kept; a resend with the same
 * key gets that answer back instead of running again. Answers of 500 and up aren't kept: that request saved nothing,
 * so the key is freed and a retry runs afresh.
 */
export function idempotency(api: FastifyInstance, db: Db) {
  const claimed = new WeakMap<FastifyRequest, string>();
  const keyOf = (req: FastifyRequest) => {
    const raw = req.headers["idempotency-key"];
    if (raw === undefined || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
    const key = String(raw).trim().replace(/^"(.*)"$/, "$1").trim();
    if (!key || key.length > MAX_KEY) throw new HttpError(400, "This request's key isn't valid. Reload the page and try again.");
    return key;
  };

  api.addHook("onRequest", async (req, reply) => {
    const key = keyOf(req);
    if (!key) return;
    const method = req.method;
    const path = req.url.split("?")[0]!;
    await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - KEEP_MS)));
    const [mine] = await db.insert(idempotencyKeys).values({ key, method, path }).onConflictDoNothing().returning({ key: idempotencyKeys.key });
    if (mine) {
      claimed.set(req, key);
      return;
    }
    const [first] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    if (first && (first.method !== method || first.path !== path))
      throw new HttpError(422, "This request's key was already used for a different action. Reload the page and try again.");
    if (first?.status == null) throw new HttpError(409, "This is already being done. Wait a moment, then reload.");
    return reply.status(first.status).send(first.body);
  });

  api.addHook("onSend", async (req, reply, payload) => {
    const key = claimed.get(req);
    if (!key) return payload;
    if (reply.statusCode >= 500) await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    else await db.update(idempotencyKeys).set({ status: reply.statusCode, body: typeof payload === "string" && payload ? JSON.parse(payload) : null }).where(eq(idempotencyKeys.key, key));
    return payload;
  });
}
