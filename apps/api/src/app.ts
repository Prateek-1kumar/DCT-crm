import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { createDb, type Db } from "./db/index.js";
import { startBoss } from "./jobs.js";
import { HttpError } from "./lib/http.js";
import { alertRoutes } from "./routes/alerts.js";
import { documentRoutes } from "./routes/documents.js";
import { miscRoutes } from "./routes/misc.js";
import { studyRoutes } from "./routes/studies.js";
import { versionRoutes } from "./routes/versions.js";

export type Ctx = { db: Db; boss: PgBoss };

/** Postgres errors a request causes (a malformed id, a number out of range): the request's fault, so 400. */
const BAD_INPUT: Record<string, string> = {
  "22P02": "Malformed id", // invalid text representation, e.g. a malformed uuid in the URL
  "22003": "A number in the request is out of range",
  "22007": "A date in the request isn't valid",
  "22008": "A date in the request is out of range",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildApp(opts: { logger?: boolean; workers?: boolean } = {}) {
  // Request logging is the method and the route pattern only: never bodies, ids or query strings (search terms, names).
  const logger = opts.logger ? { serializers: { req: (r: { method: string; routeOptions?: { url?: string } }) => ({ method: r.method, url: r.routeOptions?.url }) } } : false;
  // 1 MB: no request carries a rulebook; uploads are multipart, with their own limit.
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  const { db, pool } = createDb();
  const boss = await startBoss({ db, work: opts.workers ?? true });
  const ctx: Ctx = { db, boss };

  app.setErrorHandler((err: Error & { statusCode?: number; query?: string; cause?: { code?: string; message?: string } }, req, reply) => {
    const bad = err.cause?.code ? BAD_INPUT[err.cause.code] : undefined;
    const status = err instanceof HttpError ? err.statusCode : bad ? 400 : (err.statusCode ?? 500);
    if (status < 500) return reply.status(status).send({ statusCode: status, error: "Request Error", message: bad ?? err.message });
    // Never the error itself to the browser: a database error's message is the SQL and every value bound to it
    // (contract amounts, a whole rulebook). The log gets the query and the cause, not the values.
    req.log.error(err.query !== undefined ? { code: err.cause?.code, cause: err.cause?.message, query: err.query } : { err }, "request failed");
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
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });

  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 50 } });
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

  app.addHook("onClose", async () => {
    await boss.stop({ graceful: true, timeout: 5000 });
    await pool.end();
  });
  // not Object.assign(app, …): a Fastify instance is thenable, so awaiting it would drop extra props from the type
  return { app, ctx };
}
