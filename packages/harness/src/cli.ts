import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { compile, type CompileResult } from "./agent";
import { pdfReader } from "./pdf";
import type { LoadedDoc } from "./types";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function summarise(docs: LoadedDoc[], r: CompileResult) {
  const gridResults = Object.values(r.report.grids);
  const questions: Record<string, number> = {};
  for (const q of r.rulebook.questions) questions[q.origin] = (questions[q.origin] ?? 0) + 1;
  const open = r.rulebook.questions.filter((q) => q.state === "open").length;
  return {
    docs: docs.map((d) => d.name),
    model: r.model,
    usd: Math.round(r.usd * 100) / 100,
    turns: r.turns,
    finishes: r.finishes,
    stopReason: r.stopReason,
    terms: r.rulebook.terms.length,
    grids: r.rulebook.grids.length,
    gridsProven: gridResults.filter((g) => !g.problems.length && !g.unproven.length).length,
    quotesNotFound: Object.keys(r.report.quotes).length,
    unaccounted: r.report.unaccounted.length,
    questions,
    totalForAccountant: open + r.report.problems.length,
  };
}

async function main() {
  // pnpm runs the script from the package folder; paths are meant relative to where the person typed the command
  const base = process.env.INIT_CWD ?? process.cwd();
  const [out, ...pdfs] = process.argv.slice(2);
  if (!out || !pdfs.length) fail("Usage: pnpm --filter @dct/harness read <outDir> <pdf...>");
  if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY is not set. Add it to the .env file at the repo root, or export it, then try again.");

  const docs: LoadedDoc[] = [];
  for (const file of pdfs) {
    docs.push(await pdfReader.load(resolve(base, file)).catch((err: unknown) => fail(`${file}: ${err instanceof Error ? err.message : String(err)}`)));
  }

  const result = await compile(docs, { client: new Anthropic(), onProgress: console.log });

  const outDir = resolve(base, out);
  await mkdir(outDir, { recursive: true });
  const summary = summarise(docs, result);
  await Promise.all([
    writeFile(join(outDir, "rulebook.json"), JSON.stringify(result.rulebook, null, 2)),
    writeFile(join(outDir, "trace.json"), JSON.stringify(result.trace, null, 2)),
    writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2)),
  ]);
  console.log(`\n${JSON.stringify(summary, null, 2)}\nWritten to ${outDir}`);
  if (result.error) fail(`The read stopped because the model call failed: ${result.error}`);
}

main().catch((err: unknown) => fail(`The read failed: ${err instanceof Error ? err.message : String(err)}`));
