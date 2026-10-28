export async function setup() {
  // the API's tests never read a contract with AI (vitest's test.env doesn't reach this process)
  process.env.EXTRACTION_FAKE ??= "1";
  // vitest `test.env` reaches the test workers only; set the same test database here for migrations.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://dct:dct@localhost:5434/dct_finance_test";
  if (!process.env.DATABASE_URL.includes("_test")) throw new Error("Refusing to run tests against a non-test database");
  const { runMigrations } = await import("../src/db/migrate.js");
  await runMigrations(process.env.DATABASE_URL);
}
