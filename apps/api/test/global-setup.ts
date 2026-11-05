export async function setup() {
  // vitest `test.env` reaches the test workers only; set the same test database here for migrations.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://dct:dct@localhost:5434/dct_finance_test";
  // the database's own name: "_test" anywhere else in the URL (a user, a parameter) must not pass
  if (!new URL(process.env.DATABASE_URL).pathname.slice(1).endsWith("_test")) throw new Error("Refusing to run tests against a database whose name doesn't end in _test");
  const { runMigrations } = await import("../src/db/migrate.js");
  await runMigrations(process.env.DATABASE_URL);
  // documents from earlier runs have no files in this run's upload folder: left alone, startup would queue them for OCR and every one would fail and be retried
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("UPDATE documents SET ocr_status = 'failed'");
  await client.end();
}
