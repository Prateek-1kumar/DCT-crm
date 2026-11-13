import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook } from "@dct/shared";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { compile } from "../src/agent";
import type { ModelClient } from "../src/agent/client";
import { checks } from "../src/checks";
import { ModelError, type Ask, type Reader } from "../src/models";
import { pdfReader } from "../src/pdf";
import { NOT_REVIEWED, ReadFailed, VERIFY_PAGE_USD, defaultMaxUsd, read, readBudget } from "../src/read";
import { reviewUsd } from "../src/review";
import { SCAN_PAGE_USD, untranscribed, withScans } from "../src/scan";
import { parseTranscription } from "../src/scan/transcribe";
import type { LoadedDoc, ScanPage, ScanStore } from "../src/types";

// only the budget simulation compiles; it stands in a compile that spends all it is given, and a turn more
vi.mock("../src/agent", async (original) => ({ ...(await original<typeof import("../src/agent")>()), compile: vi.fn() }));

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
      checklist: [],
      findings: [{
        topic: null, type: "judgment", affects: "how_much", about: { target: "term", id: "sf" }, question: "Is a screen failure after Visit 1 paid in full?", context: "", doc: "CTA.pdf", page: 1,
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
  const openai = fake("gpt", { verify_page: PAGE, review: { checklist: [], findings: [] } }, 0.4);
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

  const openai = fake("gpt", { transcribe_page: PAGE, verify_page: PAGE, review: { checklist: [], findings: [] } }, 0.4);
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
  const openai = fake("gpt", { review: { checklist: [], findings: [] } }, 0.4);
  const broken = fake("claude", { find_answers: {} }, 0.1);
  const failure = await read(docs, { anthropic: {} as ModelClient, claude: broken, openai, maxUsd: 3, rulebook: { ...rulebook, questions: [elsewhere] } }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ReadFailed);
  expect((failure as ReadFailed).message).toMatch(/problem on the server/);
  expect((failure as ReadFailed).usd).toBeCloseTo(0.5);
});

it("a given --max-usd is the whole budget; otherwise the default plus an allowance for each page still to read, each scanned page's second read, and the review", () => {
  expect(readBudget(1.5, 10, 10, 1)).toBe(1.5);
  expect(readBudget(undefined, 2, 5, 0.9)).toBeCloseTo(defaultMaxUsd() + 2 * SCAN_PAGE_USD + 5 * VERIFY_PAGE_USD + 0.9);
});

it("a read whose reviewer couldn't run can't be approved: it carries a blocking item that no answer settles", async () => {
  const failing: Reader = { ...fake("gpt", {}, 0), ask: () => Promise.reject(new ModelError("the provider fell over", 0.2)) };
  const result = await read(docs, { anthropic: {} as ModelClient, claude: fake("claude", {}, 0.1), openai: failing, maxUsd: 3, rulebook });
  expect(result.reviewError).toBeDefined();
  expect(result.usd).toBeCloseTo(0.2);
  expect(result.rulebook.questions).toEqual([
    expect.objectContaining({ id: "review:not-run", kind: "decision", origin: "reviewer", question: NOT_REVIEWED, options: [], state: "open", blocking: true }),
  ]);
  expect(NOT_REVIEWED).toBe("This read wasn't checked for judgment calls. Start the read again; the pages already read are kept.");
  expect(result.rulebook.questions[0]!.context).not.toContain("fell over");

  const skipped = await read(docs, { anthropic: {} as ModelClient, claude: fake("claude", {}, 0.1), openai: fake("gpt", { review: { checklist: [], findings: [] } }, 0.4), maxUsd: 0.000001, rulebook });
  expect(skipped.rulebook.questions.map((q) => [q.id, q.blocking])).toEqual([["review:not-run", true]]);

  const reviewed = await read(docs, { anthropic: {} as ModelClient, claude: fake("claude", {}, 0.1), openai: fake("gpt", { review: { checklist: [], findings: [] } }, 0.4), maxUsd: 3, rulebook: skipped.rulebook });
  expect(reviewed.rulebook.questions).toEqual([]);
});

it("the review leaves the second reads' allowance in place", async () => {
  const scan: LoadedDoc = { ...docs[0]!, pages: docs[0]!.pages.map((p) => ({ ...p, kind: "scan" as const })) };
  const openai = fake("gpt", { review: { checklist: [], findings: [] }, read_values: { answers: [{ item: 0, answer: "$500.00" }] } }, 0);
  // the review's estimate is about $0.03 at $1 a million tokens: it fits in $0.10, but not beside one page's $0.08
  const result = await read([scan], { anthropic: {} as ModelClient, claude: fake("claude", {}, 0), openai, maxUsd: 0.1, rulebook });
  expect(result.reviewError).toMatch(/skipped/);
  expect(result.rulebook.questions.map((q) => q.id)).toContain("review:not-run");
});

const PAGES = 22;

/** A fresh read of a 22-page scan at the default budget, then a second read of it, with readers at measured prices and a compile that spends all it is given and a turn more. */
async function twoReadsOf22Pages() {
  const file = await PDFDocument.create();
  const ink = createCanvas(40, 40);
  ink.getContext("2d").fillRect(0, 0, 40, 40);
  const png = await file.embedPng(await ink.encode("png"));
  // small landscape pages: the simulation needs their count, not their size, and renders them twice
  for (let i = 0; i < PAGES; i++) file.addPage([198, 153]).drawImage(png, { x: 0, y: 0, width: 198, height: 153 });
  await writeFile(join(dir, "Budget22.pdf"), await file.save());
  const scanned = await pdfReader.load(join(dir, "Budget22.pdf"));

  // measured: about $0.15 a transcribed page, $0.02–0.08 a verify read and $0.5–1 a review, at the OpenAI model's price
  let reviews = 0;
  let transcriptions = 0;
  let verifies = 0;
  const openai: Reader = {
    model: "gpt", price: { input: 5, output: 30, cacheWrite: 0, cacheRead: 0 },
    async ask<T>(req: Ask<T>) {
      if (req.name === "transcribe_page") transcriptions++;
      if (req.name === "review") reviews++;
      if (req.name === "verify_page") verifies++;
      const page = { rotation: 0, text: "T 0.1-0.9 | Budget\nH | Procedure | Fee\nR 0.2-0.21 | Exam | $100.00" };
      const value = req.name === "review" ? { checklist: [], findings: [] } : page;
      return { value: value as T, model: "gpt", usd: { review: 1, verify_page: VERIFY_PAGE_USD }[req.name] ?? 0.15 };
    },
  };
  const OVERSHOOT = 0.3;
  let share = 0;
  vi.mocked(compile).mockImplementation(async (compiled, opts) => {
    share = opts.maxUsd!;
    const rb = { ...rulebook, terms: [], accounted: [{ doc: "Budget22.pdf", pages: compiled[0]!.pages.map((p) => p.page), reason: "synthetic" }] };
    return { rulebook: rb, report: checks.runChecks(rb, compiled), model: "claude", usd: opts.maxUsd! + OVERSHOOT, turns: 40, finishes: 1, stopReason: "done", trace: [] };
  });

  const saved: ScanPage[] = [];
  const scans: ScanStore = { get: async () => saved, put: async (_, page) => void saved.push(page) };
  const runs = [];
  for (const run of ["fresh", "pages already read"]) {
    const unread = await untranscribed([scanned], scans, openai);
    const limit = readBudget(undefined, unread, PAGES, await reviewUsd(openai, [scanned]));
    const [before, progress] = [{ reviews, transcriptions, verifies }, [] as string[]];
    const result = await read([scanned], { anthropic: {} as ModelClient, claude: fake("claude", {}, 0), openai, scans, maxUsd: limit, onProgress: (l) => progress.push(l) });
    // what compile was given before anything was set aside: 70% of the default and the transcription allowance, less what transcription spent
    const before_ = 0.7 * (defaultMaxUsd() + SCAN_PAGE_USD * unread - 0.15 * unread);
    runs.push({ run, limit, result, progress, share, before: before_, reviews: reviews - before.reviews, transcriptions: transcriptions - before.transcriptions, verifies: verifies - before.verifies });
  }
  return runs;
}

it("a 22-page scan at the default budget always runs the reviewer and the verify reads", async () => {
  for (const { run, limit, result, progress, reviews, transcriptions, verifies } of await twoReadsOf22Pages()) {
    expect(result.reviewError, run).toBeUndefined();
    expect(reviews, run).toBe(1);
    // every page prints an amount, so every page is read a second time, within the limit
    expect(verifies, run).toBe(PAGES);
    expect(result.usd, run).toBeLessThanOrEqual(limit);
    expect(result.rulebook.questions.filter((q) => q.id.endsWith(":unread")), run).toEqual([]);
    expect(transcriptions, run).toBe(run === "fresh" ? PAGES : 0);
    expect(progress.filter((l) => /^p\.\d+ of Budget22\.pdf read at \d+ dpi$/.test(l)), run).toHaveLength(run === "fresh" ? PAGES : 0);
  }
}, 30_000);

it("a 22-page scan's compile share is at least what it was before the reservations", async () => {
  for (const { run, share, before } of await twoReadsOf22Pages()) expect(share, run).toBeGreaterThanOrEqual(before);
}, 30_000);
