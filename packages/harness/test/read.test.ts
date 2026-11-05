import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook } from "@dct/shared";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ModelClient } from "../src/agent/client";
import type { Ask, Reader } from "../src/models";
import { pdfReader } from "../src/pdf";
import { ReadFailed, read } from "../src/read";
import type { LoadedDoc } from "../src/types";

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

it("refuses only pages nobody has OCR'd yet, before any model is called", async () => {
  const scan: LoadedDoc = { ...docs[0]!, pages: docs[0]!.pages.map((p) => ({ ...p, kind: "image" as const })) };
  const never = fake("x", {}, 1);
  await expect(read([scan], { anthropic: {} as ModelClient, claude: never, openai: never, rulebook })).rejects.toThrow(/Pages CTA\.pdf p\.1 haven't been prepared yet/);
});

it("reads OCR'd pages, proving an amount by what OCR read there without asking a model", async () => {
  const scan: LoadedDoc = { ...docs[0]!, pages: docs[0]!.pages.map((p) => ({ ...p, kind: "ocr" as const, confidence: 90 })) };
  const claude = fake("claude", {}, 1);
  const openai = fake("gpt", { review: { findings: [] } }, 0.4);
  const result = await read([scan], { anthropic: {} as ModelClient, claude, openai, maxUsd: 3, rulebook });
  expect(result.rulebook.terms[0]).toMatchObject({ amountCents: 50000, evidence: "ocr_match" });
  expect(result.report.problems).toEqual([]);
  expect(result.usd).toBeCloseTo(0.4);
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
