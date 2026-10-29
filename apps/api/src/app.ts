import multipart from "@fastify/multipart";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { apiPoolOptions, createDb, type Db, pendingMigrations } from "./db/index.js";
import { startBoss } from "./jobs.js";
import { HttpError } from "./lib/http.js";
import { alertRoutes } from "./routes/alerts.js";
import { documentRoutes } from "./routes/documents.js";
import { miscRoutes } from "./routes/misc.js";
import { studyRoutes } from "./routes/studies.js";
import { versionRoutes } from "./routes/versions.js";

export type Ctx = { db: Db; boss: PgBoss; log: FastifyBaseLogger };

/** Postgres errors a request causes (a malformed id, a number out of range): the request's fault, so 400. */
const BAD_INPUT: Record<string, string> = {
  "22P02": "Malformed id", // invalid text representation, e.g. a malformed uuid in the URL
  "22003": "A number in the request is out of range",
  "22007": "A date in the request isn't valid",
  "22008": "A date in the request is out of range",
};
/** Two writes to the same thing at once, one of them rolled back: nothing was saved, so trying again is safe (409). */
const CONCURRENT: Record<string, string> = {
  "40001": "serialization failure",
  "40P01": "deadlock",
  "55P03": "lock wait timed out",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** @fastify/multipart's limits, by its error codes, in plain words (its own say "request file too large"). */
const UPLOAD_LIMITS: Record<string, string> = {
  FST_REQ_FILE_TOO_LARGE: `This file is bigger than the ${config.maxUploadBytes / 1024 / 1024} MB limit. Split it into smaller PDFs and upload those.`,
  FST_FILES_LIMIT: "Upload at most 50 files at once.",
  FST_PARTS_LIMIT: "This upload has too many parts. Upload at most 50 files at once.",
  FST_FIELDS_LIMIT: "This upload has too many fields. Upload the PDFs alone.",
};

/** `p`, or a rejection once `ms` have passed. */
const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref())]);

export async function buildApp(opts: { logger?: boolean; workers?: boolean } = {}) {
  const app = Fastify({
    // JSON lines (pino). Request logging is the method and the route pattern only: never bodies, ids or query strings
    // (search terms, names); errors are logged by the handler below, without values.
    logger: opts.logger ? { level: config.logLevel, serializers: { req: (r: { method: string; routeOptions?: { url?: string } }) => ({ method: r.method, url: r.routeOptions?.url }) } } : false,
    // a UUID per request, in every log line (reqId), the x-request-id header and a 5xx message's "ref"
    genReqId: () => randomUUID(),
    // 1 MB: no request carries a rulebook; uploads are multipart, with their own limit.
    bodyLimit: 1024 * 1024,
    // A slow or stalled client can't hold a connection: the whole request (a 50 MB upload included) within this, and no
    // socket idle longer. Idle keep-alive connections close after their own timeout.
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.requestTimeoutMs,
    keepAliveTimeout: config.keepAliveTimeoutMs,
  });
  const { db, pool } = createDb(config.databaseUrl, apiPoolOptions());
  // An idle connection the database drops (a restart, a network blip) is replaced; without a listener it would crash the process.
  pool.on("error", (err) => app.log.error({ err: err.message }, "idle database connection failed"));
  const behind = await pendingMigrations(db);
  if (behind) app.log.error({ pending: behind }, "the database is behind this build: run the migrations (pnpm --filter @dct/api db:migrate), then restart");
  const boss = await startBoss({ db, log: app.log, work: opts.workers ?? true, schemaBehind: behind > 0 });
  const ctx: Ctx = { db, boss, log: app.log };
  let stopped = false;
  boss.once("stopped", () => (stopped = true));

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; query?: string; cause?: { code?: string; message?: string } }, req, reply) => {
    const limit = err.code ? UPLOAD_LIMITS[err.code] : undefined;
    if (limit) return reply.status(413).send({ statusCode: 413, error: STATUS_CODES[413], message: limit });
    const code = err.cause?.code;
    const bad = code ? BAD_INPUT[code] : undefined;
    const clash = code ? CONCURRENT[code] : undefined;
    const status = err instanceof HttpError ? err.statusCode : bad ? 400 : clash ? 409 : (err.statusCode ?? 500);
    if (clash) req.log.warn({ code, reason: clash }, "write rolled back by a concurrent one");
    if (status < 500)
      return reply.status(status).send({ statusCode: status, error: STATUS_CODES[status] ?? "Error", message: bad ?? (clash ? "Someone else was changing this at the same moment, so nothing was saved. Try again." : err.message) });
    // Never the error itself to the browser: a database error's message is the SQL and every value bound to it
    // (contract amounts, a whole rulebook). The log gets the query and the cause, not the values.
    req.log.error(err.query !== undefined ? { code, cause: err.cause?.message, query: err.query } : { err }, "request failed");
    reply.status(status).send({ statusCode: status, error: "Internal Server Error", message: `Something went wrong on the server. Try again; if it keeps happening, tell the team (ref ${req.id}).` });
  });

  // No login yet, so guard against DNS rebinding (foreign Host) and cross-site writes (foreign Origin).
  // Behind the web app's proxy the Host is always the API's own; the browser's arrives as X-Forwarded-Host, so check both.
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host?.toLowerCase();
    const forwarded = String(req.headers["x-forwarded-host"] ?? "").toLowerCase().split(",").map((h) => h.trim()).filter(Boolean);
    if (!host || ![host, ...forwarded].every((h) => config.allowedHosts.includes(h))) return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Host not allowed" });
    const origin = req.headers.origin?.toLowerCase();
    if (origin !== undefined && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !config.allowedOrigins.includes(origin))
      return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Origin not allowed" });
  });

  // Contract data is never cached or sniffed as another type; page images set their own cache header.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-request-id", req.id);
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });

  // Probes, outside /api/v1: they're for whatever runs the server, not part of the API's contract, so they never move
  // with an API version. Quiet in the log (warn and up only). The host guard applies to them too.
  app.get("/livez", { logLevel: "warn" }, async () => ({ status: "ok" }));
  app.get("/readyz", { logLevel: "warn" }, async (_req, reply) => {
    const check = async (fn: () => Promise<unknown>) => within(2000, fn()).then(() => "ok", () => "unavailable");
    const [database, jobs] = await Promise.all([check(() => db.execute(sql`SELECT 1`)), check(() => boss.getDb().executeSql("SELECT 1"))]);
    const schema = database === "ok" && (await within(2000, pendingMigrations(db)).catch(() => 1)) > 0 ? "behind" : database === "ok" ? "ok" : "unknown";
    const ready = database === "ok" && jobs === "ok" && schema === "ok" && !stopped;
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not ready", database, jobs: stopped ? "stopped" : jobs, schema });
  });

  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 50, fields: 10, parts: 60 } });
  await app.register(
    async (api) => {
      // Every :id is a uuid and every :v a version number, checked once before any route runs (never a database error).
      api.addHook("preValidation", async (req) => {
        const p = req.params as Record<string, string | undefined>;
        if (p.id !== undefined && !UUID.test(p.id)) throw new HttpError(400, "Malformed id");
        if (p.v !== undefined && !/^[1-9]\d{0,8}$/.test(p.v)) throw new HttpError(400, `Invalid version "${p.v}"`);
      });
      await api.register(documentRoutes(ctx));
      await api.register(studyRoutes(ctx));
      await api.register(versionRoutes(ctx));
      await api.register(miscRoutes(ctx));
      await api.register(alertRoutes(ctx));
    },
    { prefix: "/api/v1" },
  );

  // After the last in-flight request (Fastify's close waits for them): jobs get to finish, up to a limit (a read still
  // going then is failed by pg-boss and marked so at the next start), then the pool closes.
  app.addHook("onClose", async () => {
    await boss.stop({ graceful: true, timeout: Math.min(10_000, config.shutdownTimeoutMs / 2) });
    await pool.end();
  });
  // not Object.assign(app, …): a Fastify instance is thenable, so awaiting it would drop extra props from the type
  return { app, ctx };
}
