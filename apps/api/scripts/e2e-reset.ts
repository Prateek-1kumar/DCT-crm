// e2e only (pnpm e2e): wipe the e2e database and upload dir, then migrate. Refuses anything but a *_e2e database.
import { rm } from "node:fs/promises";
import pg from "pg";
import { config } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";

// the database's own name, never the URL: it carries the password
const dbName = new URL(config.databaseUrl).pathname.slice(1);
if (!dbName.endsWith("_e2e")) throw new Error(`e2e-reset refuses to touch database "${dbName}": needs a *_e2e database`);
if (!/dct-e2e/.test(config.uploadDir)) throw new Error(`e2e-reset refuses to delete ${config.uploadDir}`);
const client = new pg.Client(config.databaseUrl);
await client.connect();
await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;");
await client.end();
await rm(config.uploadDir, { recursive: true, force: true });
await runMigrations();
console.log("e2e database reset");
