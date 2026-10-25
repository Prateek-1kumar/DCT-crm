import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "../config.js";
import { createDb } from "./index.js";

export async function runMigrations(url = config.databaseUrl) {
  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle") });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === import.meta.filename) {
  await runMigrations();
  console.log("migrations applied");
}
