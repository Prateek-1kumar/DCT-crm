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

export async function buildApp(opts: { logger?: boolean; workers?: boolean } = {}) {
  // Default request logging is method + url only: never bodies (rulebooks, contract text).
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  const { db, pool } = createDb();
  const boss = await startBoss({ db, work: opts.workers ?? true });
  const ctx: Ctx = { db, boss };

  app.setErrorHandler((err: Error & { statusCode?: number; cause?: { code?: string } }, req, reply) => {
    // 22P02 = invalid text representation, e.g. a malformed uuid in the URL
    const badInput = err.cause?.code === "22P02";
    const status = err instanceof HttpError ? err.statusCode : badInput ? 400 : (err.statusCode ?? 500);
    if (status >= 500) req.log.error(err);
    reply.status(status).send({ statusCode: status, error: status >= 500 ? "Internal Server Error" : "Request Error", message: badInput ? "Malformed id" : err.message });
  });

  // No login yet, so guard against DNS rebinding (foreign Host) and cross-site writes (foreign Origin).
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host?.toLowerCase();
    if (!host || !config.allowedHosts.includes(host)) return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Host not allowed" });
    const origin = req.headers.origin?.toLowerCase();
    if (origin !== undefined && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !config.allowedOrigins.includes(origin))
      return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Origin not allowed" });
  });

  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 50 } });
  await app.register(
    async (api) => {
      await api.register(documentRoutes(ctx));
      await api.register(studyRoutes(ctx));
      await api.register(versionRoutes(ctx));
      await api.register(miscRoutes(ctx));
      await api.register(alertRoutes(ctx));
    },
    { prefix: "/api" },
  );

  app.addHook("onClose", async () => {
    await boss.stop({ graceful: true, timeout: 5000 });
    await pool.end();
  });
  // not Object.assign(app, …): a Fastify instance is thenable, so awaiting it would drop extra props from the type
  return { app, ctx };
}
