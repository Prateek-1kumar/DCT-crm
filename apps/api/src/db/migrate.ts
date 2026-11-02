import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "../config.js";
import { MIGRATIONS } from "./index.js";

/**
 * Applies pending migrations. A separate step before the server starts, never on boot (docs/phase-1/api.md). One
 * connection holds an advisory lock throughout, so two runs at once apply each migration once: drizzle's migrator reads
 * the last applied migration before its transaction and takes no lock of its own.
 */
export async function runMigrations(url = config.databaseUrl) {
  const client = new pg.Client({ connectionString: url, application_name: "dct-migrate" });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('dct-finance migrations'))");
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  } finally {
    await client.end(); // ends the session, and the lock with it
  }
}

if (process.argv[1] === import.meta.filename) {
  await runMigrations();
  console.log("migrations applied");
}
