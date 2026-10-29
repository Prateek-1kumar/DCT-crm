import { eq, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { Db, Tx } from "../db/index.js";
import { idempotencyKeys } from "../db/schema.js";
import { HttpError } from "./http.js";

/** How long a saved response is replayed. A key used again after that runs as a new request (Stripe: 24 hours). */
const KEY_TTL_HOURS = 24;

/** Advisory-lock key space for idempotency keys (the two-int form; it doesn't overlap the one-bigint locks elsewhere). */
const LOCKS = 7101;

/**
 * The request's Idempotency-Key: a structured-field string (`"…"`, IETF draft-ietf-httpapi-idempotency-key-header) or a
 * bare token (as Stripe takes it), 1–255 printable characters. Null when it has none.
 */
function keyOf(req: FastifyRequest): string | null {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return null;
  const m = /^"([\x21\x23-\x5b\x5d-\x7e]{1,255})"$|^([\x21\x23-\x5b\x5d-\x7e]{1,255})$/.exec(String(raw).trim());
  if (!m) throw new HttpError(400, "The Idempotency-Key header must be 1 to 255 letters, digits or symbols, such as a UUID.");
  return m[1] ?? m[2]!;
}

/** What makes two requests the same one: method, URL (path and query) and body. */
export const fingerprintOf = (req: FastifyRequest, body: unknown = req.body) =>
  createHash("sha256").update(`${req.method} ${req.url}\n${JSON.stringify(body ?? null)}`).digest("hex");

type Saved = { status: number; response: string; replayed: boolean };

/**
 * One write, all or nothing: `fn` runs in one transaction and its result is the response. With an Idempotency-Key, the
 * key, the request's fingerprint and that response are saved in the same transaction, so a write and its saved response
 * commit together or not at all (one atomic phase, as Brandur Leach describes for Stripe). Then:
 * - the same key and request again: the saved response, nothing written (`Idempotent-Replayed: true`);
 * - the same key with a different request: 422;
 * - the same key while the first is still running: waits for it on the key's lock, then replays its response; a 409
 *   if that takes longer than the lock timeout.
 * A request that fails saves nothing (it changed nothing), so a retry runs it again. `after` runs last, inside the
 * transaction once the response is saved (an upload moves its files into place there).
 */
export async function write<T>(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (tx: Tx) => Promise<T>,
  opts: { status?: number; fingerprint?: string; after?: () => Promise<void> } = {},
) {
  const key = keyOf(req);
  const status = opts.status ?? 200;
  const out = await db.transaction(async (tx): Promise<Saved> => {
    const print = key ? (opts.fingerprint ?? fingerprintOf(req)) : "";
    if (key) {
      const saved = await claim(tx, key, print);
      if (saved) return saved;
    }
    const response = JSON.stringify(await fn(tx));
    if (key) await tx.insert(idempotencyKeys).values({ key, fingerprint: print, status, response });
    await opts.after?.();
    return { status, response, replayed: false };
  });
  if (out.replayed) reply.header("idempotent-replayed", "true");
  return reply.status(out.status).type("application/json; charset=utf-8").send(out.response);
}

/** Takes the key's lock (held until this transaction ends) and returns its saved response, if it has a live one. */
async function claim(tx: Tx, key: string, print: string): Promise<Saved | null> {
  try {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCKS}, hashtext(${key}))`);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === "55P03")
      throw new HttpError(409, "This request is still being processed. Wait a moment, then try again.");
    throw err;
  }
  const [row] = await tx
    .select({ fingerprint: idempotencyKeys.fingerprint, status: idempotencyKeys.status, response: idempotencyKeys.response, expired: expired() })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key));
  if (!row) return null;
  if (row.expired) {
    await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    return null;
  }
  if (row.fingerprint !== print) throw new HttpError(422, "This Idempotency-Key was already used for a different request. Send a new key for each new action.");
  return { status: row.status, response: row.response, replayed: true };
}

const expired = () => sql<boolean>`${idempotencyKeys.createdAt} < now() - make_interval(hours => ${KEY_TTL_HOURS})`;

/** Deletes saved responses past their time (jobs.ts maintenance). */
export const deleteExpiredKeys = (db: Db) => db.delete(idempotencyKeys).where(expired());
