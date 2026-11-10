import type { FastifyBaseLogger } from "fastify";
import { PgBoss } from "pg-boss";
import { config } from "./config.js";

/** The job queue, started with no queues and no workers: the harness adds its own. */
export async function startBoss({ log }: { log: FastifyBaseLogger }): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: config.databaseUrl, useListenNotify: true, max: config.jobsDbMax, application_name: "dct-jobs" });
  boss.on("error", (err) => log.error({ err: err.message }, "pg-boss error"));
  // Its words only: a warning's data can hold job data (a slow query's bound values, an overrun's job ids).
  boss.on("warning", (w) => log.warn({ warning: w.message }, "pg-boss warning"));
  await boss.start();
  return boss;
}
