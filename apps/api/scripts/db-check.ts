// pnpm --filter @dct/api db:check: the migrations agree with src/db/schema.ts, by drizzle-kit's own diff, and their
// snapshots don't collide (two branches' migrations on one parent). `generate` runs into a copy of drizzle/ and must
// find nothing to migrate. drizzle-kit exits 0 even when it fails or writes a migration, so each is judged by what it
// prints and what it writes, never by its exit code alone. Needs no database.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const api = path.resolve(import.meta.dirname, "..");
const kit = (args: string[]) => {
  // no input: a question drizzle-kit would ask (a rename?) fails the check instead of waiting for an answer
  const r = spawnSync(path.join(api, "node_modules/.bin/drizzle-kit"), args, { cwd: api, encoding: "utf8", input: "", timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
};
const files = (dir: string) => readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

/** What's wrong with the migrations, in words; empty when they match the schema. */
export function migrationProblems(): string[] {
  const problems: string[] = [];
  const check = kit(["check", "--dialect", "postgresql", "--out", "drizzle"]);
  if (!check.ok || !check.out.includes("Everything's fine")) problems.push(`drizzle-kit check:\n${check.out}`);
  const copy = mkdtempSync(path.join(os.tmpdir(), "dct-db-check-"));
  try {
    cpSync(path.join(api, "drizzle"), copy, { recursive: true });
    // drizzle-kit reads `--out` relative to where it runs
    const gen = kit(["generate", "--dialect", "postgresql", "--schema", "./src/db/schema.ts", "--out", path.relative(api, copy)]);
    const had = new Set(files(path.join(api, "drizzle")));
    const wrote = files(copy).filter((f) => !had.has(f));
    if (!gen.ok || !gen.out.includes("No schema changes, nothing to migrate") || wrote.length)
      problems.push(`src/db/schema.ts differs from the migrations: run pnpm --filter @dct/api db:generate${wrote.length ? ` (it would write ${wrote.join(", ")})` : ""}\n${gen.out}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  return problems;
}

if (process.argv[1] === import.meta.filename) {
  const problems = migrationProblems();
  if (problems.length) {
    console.error(problems.join("\n\n"));
    process.exit(1);
  }
  console.log("the migrations match src/db/schema.ts");
}
