import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Rulebook } from "@dct/shared";
import OpenAI from "openai";
import { claudeReader, openaiReader } from "./models";
import { pdfReader } from "./pdf";
import { defaultMaxUsd, read, type ReadResult } from "./read";
import { SCAN_PAGE_USD, fileScanStore, untranscribed } from "./scan";
import type { LoadedDoc } from "./types";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function summarise(docs: LoadedDoc[], r: ReadResult) {
  const gridResults = Object.values(r.report.grids);
  const questions: Record<string, number> = {};
  for (const q of r.rulebook.questions) questions[`${q.origin} ${q.state}`] = (questions[`${q.origin} ${q.state}`] ?? 0) + 1;
  const open = r.rulebook.questions.filter((q) => q.state === "open");
  return {
    docs: docs.map((d) => d.name),
    usd: Math.round(r.usd * 100) / 100,
    ...(r.compiled && { model: r.compiled.model, compileUsd: Math.round(r.compiled.usd * 100) / 100, turns: r.compiled.turns, finishes: r.compiled.finishes, stopReason: r.compiled.stopReason }),
    ...(r.reviewError && { reviewError: r.reviewError }),
    terms: r.rulebook.terms.length,
    grids: r.rulebook.grids.length,
    gridsProven: gridResults.filter((g) => !g.problems.length && !g.unproven.length).length,
    quotesNotFound: Object.keys(r.report.quotes).length,
    unaccounted: r.report.unaccounted.length,
    questions,
    mustAnswer: open.filter((q) => q.blocking).length + r.report.problems.length,
    worthALook: open.filter((q) => !q.blocking).length,
  };
}

type Saved = { grids: object[]; questions: { origin: string; options: { patch?: unknown }[] }[] };

// Rulebooks saved before step 3 lack its fields; their rule questions predate grouping, so they are rebuilt.
async function earlier(dir: string): Promise<Rulebook> {
  const raw = JSON.parse(await readFile(join(dir, "rulebook.json"), "utf8")) as Saved;
  return Rulebook.parse({
    ...raw,
    grids: raw.grids.map((g) => ({ cellsReadTwice: [], ...g })),
    questions: raw.questions
      .filter((q) => q.origin !== "rule")
      .map((q) => ({ readings: [], resolution: null, blocking: true, ...q, options: q.options.map(({ patch, ...o }) => ({ patches: patch ? [patch] : [], ...o })) })),
  });
}

async function main() {
  // pnpm runs the script from the package folder; paths are meant relative to where the person typed the command
  const base = process.env.INIT_CWD ?? process.cwd();
  const args = process.argv.slice(2);
  const from = args[0] === "--from" ? args.splice(0, 2)[1] : undefined;
  const [out, ...pdfs] = args;
  if (!out || !pdfs.length) fail("Usage: pnpm --filter @dct/harness read [--from <earlier outDir>] <outDir> <pdf...>");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_MODEL"]) {
    if (!process.env[key]) fail(`${key} is not set. Add it to the .env file at the repo root, or export it, then try again.`);
  }

  const docs: LoadedDoc[] = [];
  for (const file of pdfs) {
    docs.push(await pdfReader.load(resolve(base, file)).catch((err: unknown) => fail(`${file}: ${err instanceof Error ? err.message : String(err)}`)));
  }

  const anthropic = new Anthropic();
  const openai = openaiReader(new OpenAI(), process.env.OPENAI_MODEL!);
  const scans = fileScanStore(resolve(base, "data/scans"));
  const result = await read(docs, {
    anthropic,
    claude: claudeReader(anthropic, process.env.HARNESS_MODEL ?? "claude-sonnet-5-5"),
    openai,
    scans,
    maxUsd: defaultMaxUsd() + SCAN_PAGE_USD * (await untranscribed(docs, scans, openai)),
    onProgress: console.log,
    ...(from && { rulebook: await earlier(resolve(base, from)) }),
  });

  const outDir = resolve(base, out);
  await mkdir(outDir, { recursive: true });
  const summary = summarise(docs, result);
  await Promise.all([
    writeFile(join(outDir, "rulebook.json"), JSON.stringify(result.rulebook, null, 2)),
    writeFile(join(outDir, "log.json"), JSON.stringify(result.log, null, 2)),
    ...(result.compiled ? [writeFile(join(outDir, "trace.json"), JSON.stringify(result.compiled.trace, null, 2))] : []),
    writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2)),
  ]);
  console.log(`\n${JSON.stringify(summary, null, 2)}\nWritten to ${outDir}`);
  if (result.compiled?.error) fail(`The read stopped because the model call failed: ${result.compiled.error}`);
}

main().catch((err: unknown) => fail(`The read failed: ${err instanceof Error ? err.message : String(err)}`));
