import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationProblems } from "../scripts/db-check.js";

// Drizzle applies only the migrations newer than the last one applied (by the journal's `when`), and never says when it
// skips one: a migration out of order, or one the journal doesn't list, never runs.

const dir = path.resolve(import.meta.dirname, "../drizzle");
const { entries } = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8")) as { entries: { idx: number; when: number; tag: string }[] };

describe("the migrations", () => {
  it("are listed in order, each newer than the one before, and each listed one is a SQL file (and only those)", () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    entries.slice(1).forEach((e, i) => expect(e.when, `${e.tag} is newer than ${entries[i]!.tag}`).toBeGreaterThan(entries[i]!.when));
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()).toEqual(entries.map((e) => `${e.tag}.sql`).sort());
  });

  it("agree with src/db/schema.ts, by drizzle-kit's own diff (pnpm --filter @dct/api db:check)", () => {
    expect(migrationProblems()).toEqual([]);
  }, 60_000);
});
