import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { config, findUp } from "../config.js";
import * as schema from "./schema.js";

export function createDb(url = config.databaseUrl, opts: pg.PoolConfig = {}) {
  const pool = new pg.Pool({ connectionString: url, ...opts });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/**
 * The API's pool. Each connection gets the server-side limits from config: a statement can't run for minutes, a lock
 * wait gives up (a 409, "try again"), and a transaction left open by a bug can't hold its locks forever.
 */
export const apiPoolOptions = (): pg.PoolConfig => ({
  max: config.db.max,
  statement_timeout: config.db.statementTimeoutMs,
  lock_timeout: config.db.lockTimeoutMs,
  idle_in_transaction_session_timeout: 60_000,
  // waiting for a free connection gives up too, instead of queueing forever
  connectionTimeoutMillis: 10_000,
  application_name: "dct-api",
});

export type Db = ReturnType<typeof createDb>["db"];
/** A db handle or a transaction: both expose the same query API. */
export type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** apps/api/drizzle, found from src (tsx) and from dist (the build) alike. */
export const MIGRATIONS = path.join(findUp("drizzle/meta/_journal.json") ?? process.cwd(), "drizzle");

let journal: { entries: { when: number }[] } | undefined;

/** How many of this build's migrations the database hasn't applied (drizzle applies those newer than its last one). */
export async function pendingMigrations(db: Db): Promise<number> {
  journal ??= JSON.parse(readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: { when: number }[] };
  const { rows } = await db.execute<{ applied: boolean }>(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS applied`);
  const last = rows[0]?.applied ? (await db.execute<{ last: string | null }>(sql`SELECT max(created_at)::text AS last FROM drizzle.__drizzle_migrations`)).rows[0]?.last : null;
  return journal.entries.filter((e) => e.when > Number(last ?? 0)).length;
}
