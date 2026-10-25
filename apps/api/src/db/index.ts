import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

export function createDb(url = config.databaseUrl) {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];
/** A db handle or a transaction: both expose the same query API. */
export type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };
