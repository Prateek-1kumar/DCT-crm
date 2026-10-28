/**
 * pnpm --filter @dct/extraction eval [name...]   live extraction of the real contracts → data/extractions/<name>.json, then score
 * pnpm --filter @dct/extraction score [name...]  score saved outputs only (no AI calls)
 *
 * Repo root (for .env and data/) = DCT_ROOT, else two levels above this package.
 * Prints counts and scores only; never contract text or amounts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runContractChecks } from "../src/checks";
import { type ExtractionOutput, extractStudy } from "../src/extract";
import { Golden, type Score, scoreExtraction } from "../src/score";

const root = process.env.DCT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const scoreOnly = args.includes("--score-only");
const only = args.filter((a) => !a.startsWith("--"));

const goldenDir = join(root, "data/golden");
const outDir = join(root, "data/extractions");
if (!existsSync(goldenDir)) {
  console.error(`No golden files in ${goldenDir}. Set DCT_ROOT to the repo checkout that has data/.`);
  process.exit(1);
}
const goldens = readdirSync(goldenDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => Golden.parse(JSON.parse(readFileSync(join(goldenDir, f), "utf8"))))
  .filter((g) => !only.length || only.includes(g.name));

if (!scoreOnly) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`Live eval skipped: ANTHROPIC_API_KEY is empty (${envFile}).`);
    console.log("Fill in the key(s) and re-run, or score saved outputs with: pnpm --filter @dct/extraction score");
    process.exit(0);
  }
  // The cross-read is Haiku unless CROSS_READ says otherwise (llm.ts clientsFromEnv); only the OpenAI one needs its own key.
  if ((process.env.CROSS_READ || "haiku").toLowerCase() === "openai" && (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL))
    console.log("Note: CROSS_READ=openai but OPENAI_API_KEY/OPENAI_MODEL not set; cross-read skipped.");
  mkdirSync(outDir, { recursive: true });
  for (const g of goldens) {
    const path = join(root, "data/contracts", g.file);
    console.log(`\n[${g.name}] extracting…`);
    const t0 = Date.now();
    try {
      const out = await extractStudy({
        documents: [{ id: g.name, filename: g.file, path, kind: null }],
        onProgress: (pct, step) => process.stdout.write(`\r  ${String(pct).padStart(3)}% ${step.padEnd(60)}`),
      });
      writeFileSync(join(outDir, `${g.name}.json`), JSON.stringify(out, null, 2));
      const usd = out.cost.reduce((a, c) => a + c.usd, 0);
      console.log(`\n  done in ${Math.round((Date.now() - t0) / 1000)}s, $${usd.toFixed(2)}${out.warnings.length ? `; warnings: ${out.warnings.join("; ")}` : ""}`);
    } catch (e) {
      console.log(`\n  FAILED: ${(e as Error).message}`);
    }
  }
}

// ---- score
const rows: { score: Score; usd: number | null; anomalies: string }[] = [];
for (const g of goldens) {
  const file = join(outDir, `${g.name}.json`);
  if (!existsSync(file)) {
    console.log(`[${g.name}] no saved extraction at ${file}`);
    continue;
  }
  const out = JSON.parse(readFileSync(file, "utf8")) as ExtractionOutput;
  const anomalies = runContractChecks(out.rulebook, { crossRead: out.crossRead, pages: out.pages, notes: out.notes });
  const counts = new Map<string, number>();
  for (const a of anomalies) counts.set(a.code, (counts.get(a.code) ?? 0) + 1);
  rows.push({
    score: scoreExtraction(out.rulebook, anomalies, g),
    usd: out.cost?.reduce((a, c) => a + c.usd, 0) ?? null,
    anomalies: [...counts].map(([c, n]) => `${c}×${n}`).join(" "),
  });
}
if (!rows.length) process.exit(0);

const cats = [...new Set(rows.flatMap((r) => r.score.categories.map((c) => c.name)))];
const table = rows.map((r) => ({
  contract: r.score.name,
  score: `${r.score.pct}%`,
  ...Object.fromEntries(cats.map((c) => {
    const x = r.score.categories.find((y) => y.name === c);
    return [c, x ? `${x.hit}/${x.total}` : "-"];
  })),
  "cost $": r.usd === null ? "?" : r.usd.toFixed(2),
}));
console.log("\n");
console.table(table);
const totalUsd = rows.reduce((a, r) => a + (r.usd ?? 0), 0);
console.log(`Total cost: $${totalUsd.toFixed(2)} (avg $${(totalUsd / rows.length).toFixed(2)} per contract)`);
// Misses as counts per category: their text names items and amounts of the contract.
for (const r of rows) {
  const misses = r.score.categories.filter((c) => c.hit < c.total).map((c) => `${c.name} ${c.total - c.hit}`);
  console.log(`\n[${r.score.name}] anomalies: ${r.anomalies || "none"}; misses: ${misses.join(", ") || "none"}`);
}
