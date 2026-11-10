// Free measurements of scanned-value proof (§5.5). Prints counts only, never contract text or values.
//   pair:   two saved reads of one page, compared as the resolver compares them
//           pnpm --filter @dct/harness scan-replay pair <first.json> <second.json>
//   replay: an earlier rulebook (from before citations) against the saved transcriptions, matched by value and page
//           pnpm --filter @dct/harness scan-replay replay <data/scans> <rulebook.json> <pdf...>
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Rulebook } from "@dct/shared";
import { coverage, findQuote } from "../src/checks/coverage";
import { buildPage } from "../src/pdf/page";
import { withScans } from "../src/scan";
import { amountsOf } from "../src/scan/cells";
import { diffReads, type Verdict } from "../src/scan/diff";
import { Compact, parseTranscription, Transcription } from "../src/scan/transcribe";
import type { LoadedDoc, ScanPage } from "../src/types";

type Outcome = Verdict["outcome"];
type Counts = Record<Outcome, number>;
const none = (): Counts => ({ agree: 0, differ: 0, marked: 0, unaligned: 0 });

/** A saved read in any of the forms it was kept in: a Transcription, the model's compact text, or either under `value`. */
export function transcriptionOf(json: unknown): Transcription {
  const inner = typeof json === "object" && json !== null && "value" in json ? json.value : json;
  const compact = Compact.safeParse(inner);
  return compact.success ? parseTranscription(compact.data) : Transcription.parse(inner);
}

/** Outcomes of every amount in the first read, by its table ("t1", "t2") or "lines". */
export function pairCounts(first: Transcription, second: Transcription): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  for (const [id, verdict] of diffReads(1, first, second)) {
    const where = /^p1\.(t\d+)\./.exec(id)?.[1] ?? "lines";
    (out[where] ??= none())[verdict.outcome]++;
  }
  return out;
}

/** Amounts coverage would list as possibly missed: printed in the second read with nothing beside them in the first. */
export function missedCount(first: Transcription, second: Transcription): number {
  const read = (transcription: Transcription): ScanPage[] => [{ page: 1, version: "", rotation: 0, transcription }];
  const doc = withScans({ name: "page", path: "page", sha256: "", pages: [buildPage(1, [], "image")] }, read(first), read(second));
  const empty = { study: { documents: [] }, terms: [], grids: [], accounted: [], questions: [] } as unknown as Rulebook;
  return coverage(empty, [doc]).pages.flatMap((p) => p.amounts).filter((a) => a.reason?.startsWith("a second read")).length;
}

interface Found {
  /** Rulebook values on scanned pages whose amount is printed in exactly one transcribed cell or line of their page, in two or more, or in none. */
  one: number;
  many: number;
  nowhere: number;
}
interface PageReport extends Found {
  /** Amounts in table cells that coverage would call missing once every value with exactly one match cites it; lines apart. */
  missingInTables: number;
  missingInLines: number;
}
export interface Replay {
  pages: Record<string, PageReport>;
  rowNames: { total: number; notFound: number };
  /** Values of grids spread over several scanned pages, and those printed only on a page after the grid's first. */
  multiPage: { values: number; elsewhere: number };
}

interface Spot {
  doc: string;
  home: string;
  pages: number[];
  cents: number;
  cite(id: string): void;
}

/**
 * `docs` names each contract file the rulebook cites by the hash its scans are kept under, and labels it for the output
 * (doc1, doc2, ...), so no file name is printed.
 */
export function replayCounts(rulebook: Rulebook, docs: { name: string; label: string; sha256: string; scans: ScanPage[] }[]): Replay {
  const loaded: LoadedDoc[] = docs.map((d) => {
    const scanned = new Set(d.scans.map((p) => p.page));
    const last = Math.max(0, ...scanned);
    // pages without a scan are left blank, so a continued table still finds the page before it
    const pages = Array.from({ length: last }, (_, i) => buildPage(i + 1, [], scanned.has(i + 1) ? "image" : "text"));
    return withScans({ name: d.name, path: d.name, sha256: d.sha256, pages }, d.scans);
  });
  const labelOf = new Map(docs.map((d) => [d.name, d.label]));
  const pageOf = (doc: string, n: number) => loaded.find((d) => d.name === doc)?.pages.find((p) => p.page === n);
  const scanned = (doc: string, n: number) => pageOf(doc, n)?.kind === "scan";
  const cited: Rulebook = structuredClone(rulebook);
  const spots: Spot[] = [];
  const replay: Replay = { pages: {}, rowNames: { total: 0, notFound: 0 }, multiPage: { values: 0, elsewhere: 0 } };
  const pageReport = (key: string) => (replay.pages[key] ??= { one: 0, many: 0, nowhere: 0, missingInTables: 0, missingInLines: 0 });

  for (const t of cited.terms) {
    const { doc, page } = t.source;
    if (!scanned(doc, page)) continue;
    const home = `${labelOf.get(doc)} p.${page}`;
    if (t.amountCents !== null) spots.push({ doc, home, pages: [page], cents: t.amountCents, cite: (id) => (t.source.cell = id) });
    const cap = t.cap;
    if (cap?.kind === "amount" && cap.value !== null) spots.push({ doc, home, pages: [page], cents: cap.value, cite: (id) => (t.source.capCell = id) });
  }
  for (const g of cited.grids) {
    const pages = g.pages.filter((n) => scanned(g.doc, n));
    if (!pages.length) continue;
    const home = `${labelOf.get(g.doc)} p.${pages[0]}`;
    const cellIds: Record<string, string | null> = (g.cellIds = {});
    const add = (path: string, cents: unknown) => {
      if (typeof cents === "number" && cents !== 0) spots.push({ doc: g.doc, home, pages, cents, cite: (id) => (cellIds[path] = id) });
    };
    g.rows.forEach((r, i) => {
      add(`rows.${i}.unitCostCents`, r.unitCostCents);
      r.cells.forEach((c, j) => add(`rows.${i}.cells.${j}`, c));
      add(`rows.${i}.printedRowTotalCents`, r.printedRowTotalCents);
      replay.rowNames.total++;
      if (pages.every((n) => !findQuote(pageOf(g.doc, n)!.words, r.name).length)) replay.rowNames.notFound++;
    });
    for (const line of ["subtotal", "overhead", "total"] as const) g[line]?.forEach((c, j) => add(`${line}.${j}`, c));
    g.additions.forEach((a, i) => a.cells.forEach((c, j) => add(`additions.${i}.cells.${j}`, c)));
    add("grandTotalCents", g.grandTotalCents);
  }

  for (const spot of spots) {
    const matches = spot.pages.flatMap((n) => (pageOf(spot.doc, n)?.cells ?? []).filter((c) => amountsOf(c.text).includes(Math.abs(spot.cents))));
    const report = pageReport(spot.home);
    if (matches.length === 1) {
      report.one++;
      spot.cite(matches[0]!.id);
    } else if (matches.length) report.many++;
    else report.nowhere++;
    if (spot.pages.length > 1) {
      replay.multiPage.values++;
      if (matches.length && matches.every((c) => c.page !== spot.pages[0])) replay.multiPage.elsewhere++;
    }
  }

  for (const page of coverage(cited, loaded).pages) {
    const cells = pageOf(page.doc, page.page)?.cells;
    if (!cells) continue;
    // coverage gives each amount the text of the row it is on, as here
    const rowText = (c: (typeof cells)[number]) => cells.filter((x) => x.table === c.table && x.row === c.row).map((x) => x.text).join(" ").trim().slice(0, 120);
    for (const a of page.amounts.filter((x) => x.status === "missing")) {
      const inTable = cells.some((c) => c.row !== null && c.col && rowText(c) === a.line);
      pageReport(`${labelOf.get(page.doc)} p.${page.page}`)[inTable ? "missingInTables" : "missingInLines"]++;
    }
  }
  return replay;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // JSON.parse quotes the text around a fault, and that text is a contract's
    throw new Error(`${path} could not be read as JSON`);
  }
}

function printPair(counts: Record<string, Counts>) {
  const sum = none();
  console.log("where | agree | differ | marked | unaligned");
  for (const [where, c] of Object.entries(counts)) {
    console.log(`${where} | ${c.agree} | ${c.differ} | ${c.marked} | ${c.unaligned}`);
    for (const k of Object.keys(sum) as Outcome[]) sum[k] += c[k];
  }
  console.log(`total | ${sum.agree} | ${sum.differ} | ${sum.marked} | ${sum.unaligned}`);
}

function printReplay(r: Replay) {
  const sum = { one: 0, many: 0, nowhere: 0, missingInTables: 0, missingInLines: 0 };
  console.log("page | values in one cell | in 2+ cells | in none | missing amounts if cited: table cells | lines");
  for (const [page, p] of Object.entries(r.pages).sort()) {
    console.log(`${page} | ${p.one} | ${p.many} | ${p.nowhere} | ${p.missingInTables} | ${p.missingInLines}`);
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += p[k];
  }
  console.log(`total | ${sum.one} | ${sum.many} | ${sum.nowhere} | ${sum.missingInTables} | ${sum.missingInLines}`);
  console.log(`grid row names not found on their pages: ${r.rowNames.notFound} of ${r.rowNames.total}`);
  console.log(`multi-page grid values printed only after the grid's first page: ${r.multiPage.elsewhere} of ${r.multiPage.values}`);
}

async function main() {
  // pnpm runs the script from the package folder; paths are meant relative to where the person typed the command
  const base = process.env.INIT_CWD ?? process.cwd();
  const [mode, ...rest] = process.argv.slice(2);
  const paths = rest.map((p) => resolve(base, p));
  if (mode === "pair" && paths.length === 2) {
    const [first, second] = await Promise.all(paths.map(async (p) => transcriptionOf(await readJson(p))));
    printPair(pairCounts(first!, second!));
    console.log(`amounts only the second read found (possibly missed): ${missedCount(first!, second!)}`);
    return;
  }
  if (mode === "replay" && paths.length >= 3) {
    const [scansDir, rulebookPath, ...pdfs] = paths as [string, string, ...string[]];
    const rulebook = (await readJson(rulebookPath)) as Rulebook;
    const files = new Set(await readdir(scansDir));
    const docs = await Promise.all(
      pdfs.map(async (pdf, i) => {
        const sha256 = createHash("sha256").update(await readFile(pdf)).digest("hex");
        const file = `${sha256}.scan.json`;
        const saved = files.has(file) ? ((await readJson(join(scansDir, file))) as Partial<ScanPage>[]) : [];
        return { name: basename(pdf), label: `doc${i + 1}`, sha256, scans: saved.filter((p): p is ScanPage => !!p.transcription) };
      }),
    );
    for (const d of docs) console.log(`${d.label}: ${d.scans.length} scanned pages saved`);
    printReplay(replayCounts(rulebook, docs));
    return;
  }
  console.error("usage: scan-replay pair <first.json> <second.json>\n       scan-replay replay <data/scans> <rulebook.json> <pdf...>");
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
