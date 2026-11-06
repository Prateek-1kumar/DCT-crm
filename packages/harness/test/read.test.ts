import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook } from "@dct/shared";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ModelClient } from "../src/agent/client";
import type { Ask, Reader } from "../src/models";
import { pdfReader } from "../src/pdf";
import { ReadFailed, defaultMaxUsd, read, readBudget } from "../src/read";
import { SCAN_PAGE_USD, withScans } from "../src/scan";
import { parseTranscription } from "../src/scan/transcribe";
import type { LoadedDoc, ScanPage, ScanStore } from "../src/types";

const CLAUSE = "Screen failures are paid at the full visit rate of $500.00 per subject.";
const FILLER = "This page carries ordinary contract wording so that it has a real text layer and is not mistaken for a scan.";

let dir: string;
let docs: LoadedDoc[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-read-"));
  const file = await PDFDocument.create();
  const font = await file.embedFont(StandardFonts.Helvetica);
  const page = file.addPage([612, 792]);
  [CLAUSE, FILLER, FILLER].forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 16, size: 9, font }));
  await writeFile(join(dir, "CTA.pdf"), await file.save());
  docs = [await pdfReader.load(join(dir, "CTA.pdf"))];
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const rulebook: Rulebook = {
  study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [] },
  terms: [{
    id: "sf", category: "screen_failure", name: "Screen failure", amountCents: 50000, unit: "per subject", billing: "invoice", trigger: null, cap: null,
    formula: null, conditions: null, holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null,
    source: { doc: "CTA.pdf", page: 1, quote: "Screen failures are paid at the full visit rate" }, evidence: "quote", houseRuleIds: [], notes: null,
  }],
  grids: [], accounted: [], questions: [],
};

const fake = (model: string, answers: Record<string, unknown>, usd: number): Reader => ({
  model,
  price: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
  async ask<T>(req: Ask<T>) {
    return { value: answers[req.name] as T, model, usd };
  },
});

const sfOptions = [
  { label: "Paid in full", patches: [{ target: "term" as const, id: "sf", set: { formula: "full visit rate" } }] },
  { label: "Pro-rated", patches: [{ target: "term" as const, id: "sf", set: { formula: "pro-rated" } }] },
];

it("reviews a saved rulebook, settles the reader's elsewhere question by a verified quote, and leaves the reviewer's for a person", async () => {
  const elsewhere = {
    id: "q1", kind: "elsewhere" as const, origin: "compile" as const, about: { target: "term" as const, id: "sf" }, question: "Are screen failures pro-rated?", context: "",
    source: { doc: "CTA.pdf", page: 1, quote: "" }, options: sfOptions, suggestion: null, state: "open" as const, blocking: true, readings: [], resolution: null,
  };
  const openai = fake("gpt", {
    review: {
      findings: [{
        type: "judgment", affects: "how_much", about: { target: "term", id: "sf" }, question: "Is a screen failure after Visit 1 paid in full?", context: "", doc: "CTA.pdf", page: 1,
        quote: "", region: null, suggestion: null, newTerm: null, options: [{ label: "Yes", changes: [] }, { label: "No", changes: [] }],
      }],
    },
  }, 0.4);
  const claude = fake("claude", { find_answers: { answers: [{ question: 0, found: true, doc: "CTA.pdf", page: 1, quote: "paid at the full visit rate", option: 0 }] } }, 0.1);

  const result = await read(docs, { anthropic: {} as ModelClient, claude, openai, maxUsd: 3, rulebook: { ...rulebook, questions: [elsewhere] } });

  expect(result.usd).toBeCloseTo(0.5);
  expect(result.rulebook.terms[0]!.formula).toBe("full visit rate");
  expect(result.rulebook.questions).toMatchObject([
    { id: "q1", state: "auto_resolved", resolution: { by: "citation", citation: { doc: "CTA.pdf", page: 1 } } },
    { id: "review:0", origin: "reviewer", kind: "decision", state: "open", blocking: true },
  ]);
});

it("won't start on a file with scanned pages when there's nowhere to keep what is read from them, and calls no model", async () => {
  const scan: LoadedDoc = { ...docs[0]!, pages: docs[0]!.pages.map((p) => ({ ...p, kind: "image" as const })) };
  const never = fake("x", {}, 1);
  await expect(read([scan], { anthropic: {} as ModelClient, claude: never, openai: never, rulebook })).rejects.toThrow(/nowhere to keep/);
});

const PAGE = { rotation: 0, text: `L 0.100-0.120 | ${CLAUSE}` };
const citing = (doc: string): Rulebook => ({ ...rulebook, terms: [{ ...rulebook.terms[0]!, source: { ...rulebook.terms[0]!.source, doc, cell: "p1.l1" } }] });

it("reads transcribed pages, proving an amount by a blind second read from the vision reader alone", async () => {
  const images: LoadedDoc = { ...docs[0]!, pages: docs[0]!.pages.map((p) => ({ ...p, kind: "image" as const })) };
  const scan = withScans(images, [{ page: 1, version: "v", rotation: 0, transcription: parseTranscription(PAGE) }]);
  const claude = fake("claude", {}, 1);
  const openai = fake("gpt", { verify_page: PAGE, review: { findings: [] } }, 0.4);
  const result = await read([scan], { anthropic: {} as ModelClient, claude, openai, maxUsd: 3, rulebook: citing("CTA.pdf") });
  expect(result.rulebook.terms[0]).toMatchObject({ amountCents: 50000, evidence: "two_reads" });
  expect(result.report.problems).toEqual([]);
  expect(result.usd).toBeCloseTo(0.8);
});

it("transcribes scanned pages first, paid from the same budget, and saves them", async () => {
  const image = await PDFDocument.create();
  const canvas = createCanvas(40, 40);
  canvas.getContext("2d").fillRect(0, 0, 40, 40);
  image.addPage([612, 792]).drawImage(await image.embedPng(await canvas.encode("png")), { x: 0, y: 0, width: 612, height: 792 });
  await writeFile(join(dir, "Scan.pdf"), await image.save());
  const scanned = await pdfReader.load(join(dir, "Scan.pdf"));
  expect(scanned.pages[0]!.kind).toBe("image");

  const openai = fake("gpt", { transcribe_page: PAGE, verify_page: PAGE, review: { findings: [] } }, 0.4);
  const saved: ScanPage[] = [];
  const scans: ScanStore = { get: async () => saved, put: async (_, page) => void saved.push(page) };
  const progress: string[] = [];

  const result = await read([scanned], { anthropic: {} as ModelClient, claude: fake("claude", {}, 1), openai, scans, maxUsd: 3, rulebook: citing("Scan.pdf"), onProgress: (l) => progress.push(l) });
  expect(saved).toHaveLength(1);
  expect(progress).toContain("Reading scanned pages: 1 of 1");
  expect(result.rulebook.terms[0]).toMatchObject({ amountCents: 50000, evidence: "two_reads" });
  expect(result.usd).toBeCloseTo(1.2);
});

it("reports what was spent when a read breaks part way, with a plain message", async () => {
  const elsewhere = {
    id: "q1", kind: "elsewhere" as const, origin: "compile" as const, about: null, question: "Is it pro-rated?", context: "",
    source: { doc: "CTA.pdf", page: 1, quote: "" }, options: sfOptions, suggestion: null, state: "open" as const, blocking: true, readings: [], resolution: null,
  };
  const openai = fake("gpt", { review: { findings: [] } }, 0.4);
  const broken = fake("claude", { find_answers: {} }, 0.1);
  const failure = await read(docs, { anthropic: {} as ModelClient, claude: broken, openai, maxUsd: 3, rulebook: { ...rulebook, questions: [elsewhere] } }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ReadFailed);
  expect((failure as ReadFailed).message).toMatch(/problem on the server/);
  expect((failure as ReadFailed).usd).toBeCloseTo(0.5);
});

it("a given --max-usd is the whole budget; otherwise the default plus an allowance for each page still to read", () => {
  expect(readBudget(1.5, 10)).toBe(1.5);
  expect(readBudget(undefined, 2)).toBeCloseTo(defaultMaxUsd() + 2 * SCAN_PAGE_USD);
});
