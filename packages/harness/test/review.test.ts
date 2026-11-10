import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rulebook } from "@dct/shared";
import type { Ask, Budget, Part, Reader } from "../src/models/reader";
import { pdfReader } from "../src/pdf";
import { review } from "../src/review";
import type { Finding } from "../src/review/schema";
import type { LoadedDoc, Page, PageKind } from "../src/types";

type Term = Rulebook["terms"][number];

const page = (n: number, kind: PageKind, layout: string): Page => ({ page: n, kind, layout, raw: layout, words: [], maskBoxes: [], firstLine: "", rotation: 0 });
const doc = (name: string, ...pages: Page[]): LoadedDoc => ({ name, path: `/x/${name}`, sha256: "0", pages });

const term = (over: Partial<Term>): Term => ({
  id: "t1", category: "screen_failure", name: "Screen failure", amountCents: 599500, unit: "per patient", billing: "invoice", trigger: null, cap: null,
  formula: null, conditions: null, holdbackApplies: "yes", overheadApplies: "no", deadline: null,
  source: { doc: "CTA.pdf", page: 1, quote: "x" }, evidence: "quote", houseRuleIds: [], notes: null, ...over,
});

const role = (name: string, hasMoney: boolean) => ({ doc: name, role: "cta" as const, hasMoney, supersedes: [], effectiveFrom: null, retroactive: false, notes: null });

const rulebook = (over: Partial<Rulebook> = {}): Rulebook => ({
  study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [role("CTA.pdf", true), role("Protocol.pdf", false)] },
  terms: [term({})],
  grids: [{
    id: "g1", name: "Budget", arm: null, doc: "CTA.pdf", pages: [1], visits: ["V1", "V2"], overheadPct: 35,
    rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000, 20000], printedRowTotalCents: 30000 }],
    subtotal: [10000, 20000], overhead: null, additions: [], total: null, grandTotalCents: 30000, cellsReadTwice: [], acceptedAsPrinted: false,
  }],
  accounted: [], questions: [], ...over,
});

const YES = { label: "Yes, in full", changes: [] };
const NO = { label: "No, pro-rate it", changes: [] };

const finding = (over: Partial<Finding> = {}): Finding => ({
  type: "judgment", affects: "how_much", about: { target: "term", id: "t1" }, question: "Is a screen failure paid in full?", context: "The contract says nothing about pro-rating.",
  doc: "CTA.pdf", page: 1, quote: "Screen failure", region: null, options: [YES, NO], suggestion: null, newTerm: null, ...over,
});

const fake = (findings: Finding[], usd = 0.05) => {
  const calls: Ask<unknown>[] = [];
  const reader: Reader = {
    model: "fake",
    price: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
    async ask<T>(req: Ask<T>) {
      calls.push(req);
      return { value: { findings } as T, model: "fake", usd };
    },
  };
  return { reader, calls };
};

const docs = [doc("CTA.pdf", page(1, "text", "Screen failure  $5,995.00")), doc("Protocol.pdf", page(1, "text", "Visit schedule"))];
const budget = (): Budget => ({ limit: 1, spent: 0 });
const run = async (findings: Finding[], rb = rulebook()) => (await review(rb, docs, { ...fake(findings), budget: budget() })).questions;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-review-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("review input", () => {
  const texts = (parts: Part[]) => parts.flatMap((p) => (p.type === "text" ? [p.text] : []));

  it("sends the rulebook, the open questions, and only money-bearing documents", async () => {
    const { reader, calls } = fake([]);
    const extra = doc("Unlisted.pdf", page(1, "text", "Fee $10.00"));
    await review(rulebook(), [...docs, extra], { reader, budget: budget() });
    const sent = texts(calls[0]!.parts);
    expect(sent.some((t) => t.startsWith("Rulebook:") && t.includes('"t1"'))).toBe(true);
    expect(sent).toContain("=== CTA.pdf p1 ===\nScreen failure  $5,995.00");
    expect(sent).toContain("=== Unlisted.pdf p1 ===\nFee $10.00");
    expect(sent.join("\n")).not.toContain("Protocol.pdf p1");
    expect(calls[0]!.effort).toBe("high");
  });

  it("sends a scan as an image under a label", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([612, 792]).drawText("Screen failure $5,995.00", { x: 50, y: 700, size: 12, font });
    const path = join(dir, "scan.pdf");
    await writeFile(path, await pdf.save());
    const loaded = await pdfReader.load(path);
    const scan: LoadedDoc = { ...loaded, name: "CTA.pdf", pages: loaded.pages.map((p) => ({ ...p, kind: "image" as const })) };

    const { reader, calls } = fake([]);
    await review(rulebook(), [scan], { reader, budget: budget() });
    const parts = calls[0]!.parts;
    const i = parts.findIndex((p) => p.type === "image");
    expect(parts[i - 1]).toMatchObject({ type: "text", text: expect.stringContaining("CTA.pdf p1") });
    expect(Buffer.isBuffer((parts[i] as { png: Buffer }).png)).toBe(true);
    expect(texts(parts).join("\n")).not.toContain("Screen failure  $5,995.00");
  });
});

describe("review input for a scan page", () => {
  it("the reviewer gets the image and the transcription for a scan page", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const path = join(dir, "scanned-page.pdf");
    await writeFile(path, await pdf.save());
    const loaded = await pdfReader.load(path);
    const scan: LoadedDoc = { ...loaded, name: "CTA.pdf", pages: [{ ...loaded.pages[0]!, kind: "scan", layout: "Screen failure  $5,995.00" }] };

    const { reader, calls } = fake([]);
    await review(rulebook(), [scan], { reader, budget: budget() });
    const parts = calls[0]!.parts;
    const i = parts.findIndex((p) => p.type === "image");
    expect(parts[i - 1]).toMatchObject({ type: "text", text: expect.stringMatching(/^=== CTA\.pdf p1 ===.*transcribed from the image.*attached\)\nScreen failure {2}\$5,995\.00$/) });
  });
});

describe("review budget and errors", () => {
  it("makes no call once the budget is spent", async () => {
    const { reader, calls } = fake([finding()]);
    const result = await review(rulebook(), docs, { reader, budget: { limit: 1, spent: 1 } });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ questions: [], usd: 0, log: [], error: "The review was skipped: it would pass this read's $1.00 limit." });
  });

  it("adds the call's cost to the budget", async () => {
    const b = budget();
    const result = await review(rulebook(), docs, { ...fake([], 0.25), budget: b });
    expect(result.usd).toBe(0.25);
    expect(b.spent).toBe(0.25);
  });

  it("skips the review when its estimated cost would pass the limit, even with money left", async () => {
    const { reader, calls } = fake([]);
    const pricey: Reader = { ...reader, price: { input: 1e6, output: 1e6, cacheWrite: 0, cacheRead: 0 } };
    const result = await review(rulebook(), docs, { reader: pricey, budget: { limit: 3, spent: 0 } });
    expect(calls).toHaveLength(0);
    expect(result.error).toMatch(/would pass/);
  });

  it("returns a reader error with no questions", async () => {
    const reader: Reader = { model: "fake", price: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, ask: () => Promise.reject(new Error("rate limited")) };
    const result = await review(rulebook(), docs, { reader, budget: budget() });
    expect(result).toEqual({ questions: [], usd: 0, log: [], error: "The review could not be completed: rate limited" });
  });
});

describe("finding to question", () => {
  it("maps a finding and drops one on a page that does not exist", async () => {
    const qs = await run([finding({ page: 9 }), finding({ region: [0.1, 0.2, 0.5, 0.4] })]);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({
      id: "review:1", kind: "decision", origin: "reviewer", state: "open", blocking: true, readings: [], resolution: null,
      about: { target: "term", id: "t1" }, source: { doc: "CTA.pdf", page: 1, quote: "Screen failure", region: [0.1, 0.2, 0.5, 0.4] },
    });
    expect((await run([finding({ doc: "Nope.pdf" })]))).toEqual([]);
  });

  it("drops findings that change no money, and lets only the first six hold up approval", async () => {
    const qs = await run([finding({ affects: "none" }), ...Array.from({ length: 8 }, () => finding({ affects: "when_paid" }))]);
    expect(qs).toHaveLength(8);
    expect(qs.map((q) => q.blocking)).toEqual([true, true, true, true, true, true, false, false]);
  });

  it("clears an about that is not in the rulebook, and a quote that is not on the page", async () => {
    const qs = await run([finding({ about: { target: "term", id: "zzz" }, quote: "words that are not there" }), finding({ about: { target: "none", id: null } })]);
    expect(qs.map((q) => q.about)).toEqual([null, null]);
    expect(qs[0]!.source.quote).toBe("");
    expect((await run([finding({ about: { target: "study", id: "CTA.pdf" } })]))[0]!.about).toEqual({ target: "study", id: "CTA.pdf" });
  });

  it("drops a region outside 0 to 1 or with its corners the wrong way round", async () => {
    const regions = [[0, 0, 1.2, 1], [0.5, 0.1, 0.2, 0.9], [0.1, 0.5, 0.9, 0.5], [0.1, 0.2, 0.3]];
    const qs = await run(regions.map((region) => finding({ region })));
    expect(qs.map((q) => q.source.region)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("turns changes into patches: amounts to cents, grid cells to cents or text", async () => {
    const [q] = await run([
      finding({
        options: [
          { label: "Pro-rate", changes: [
            { target: "term", id: "t1", field: "amount", value: "$4,000.00" },
            { target: "term", id: "t1", field: "formula", value: "pro-rated by procedures completed" },
            { target: "grid", id: "g1", field: "rows.0.cells.1", value: "$250.00" },
            { target: "grid", id: "g1", field: "rows.0.cells.0", value: "Invoice" },
            { target: "grid", id: "g1", field: "overheadPct", value: "40%" },
          ] },
          NO,
        ],
      }),
    ]);
    expect(q!.options[0]!.patches).toEqual([
      { target: "term", id: "t1", set: { amountCents: 400000 } },
      { target: "term", id: "t1", set: { formula: "pro-rated by procedures completed" } },
      { target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } },
      { target: "grid", id: "g1", set: { "rows.0.cells.0": "Invoice" } },
      { target: "grid", id: "g1", set: { overheadPct: 40 } },
    ]);
  });

  it("drops changes that do not validate, and options left with none", async () => {
    const bad = [
      { target: "term" as const, id: "t1", field: "billing", value: "whenever" },
      { target: "term" as const, id: "t1", field: "amount", value: "lots" },
      { target: "term" as const, id: "t1", field: "evidence", value: "math" },
      { target: "term" as const, id: "t1", field: "nonsense", value: "x" },
      { target: "term" as const, id: "gone", field: "name", value: "x" },
      { target: "grid" as const, id: "g1", field: "rows.5.cells.0", value: "$1.00" },
      { target: "grid" as const, id: "g1", field: "__proto__.polluted", value: "x" },
      { target: "grid" as const, id: "g1", field: "grandTotalCents", value: "n/a" },
    ];
    const [q] = await run([
      finding({
        options: [
          { label: "All bad", changes: bad },
          { label: "Half good", changes: [bad[0]!, { target: "term", id: "t1", field: "billing", value: "auto_paid" }] },
          { label: "No, leave it as it is", changes: [] },
        ],
        suggestion: { option: 2, reason: "Simplest." },
      }),
    ]);
    expect(q!.options).toEqual([
      { label: "Half good", patches: [{ target: "term", id: "t1", set: { billing: "auto_paid" } }] },
      { label: "No, leave it as it is", patches: [] },
    ]);
    expect(q!.suggestion).toEqual({ option: 1, reason: "Simplest." });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a reviewer finding with no options is not raised", async () => {
    const { reader } = fake([finding({ options: [] }), finding({ options: [YES] }), finding({ question: "Is the archive fee billed?" })]);
    const result = await review(rulebook(), docs, { reader, budget: budget() });
    expect(result.questions.map((q) => q.question)).toEqual(["Is the archive fee billed?"]);
    expect(result.log).toEqual([
      expect.stringContaining('"Is a screen failure paid in full?" came with fewer than two answer choices'),
      expect.stringContaining("fewer than two answer choices"),
    ]);
  });

  it("keeps a money question whose choices don't fit the rulebook, saying the answer changes no figures", async () => {
    const bad = (label: string) => ({ label, changes: [{ target: "term" as const, id: "no_such_term", field: "billing", value: "invoice" }] });
    const [q] = await run([finding({ options: [bad("Yes, one cap covers both"), bad("No, separate caps")], suggestion: { option: 1, reason: "r" } })]);
    expect(q!.options).toEqual([
      { label: "Yes, one cap covers both", patches: [] },
      { label: "No, separate caps", patches: [] },
    ]);
    expect(q!.suggestion).toEqual({ option: 1, reason: "r" });
    expect(q!.context).toContain("doesn't change the rulebook's figures");
  });

  it("drops a suggestion that points at a dropped option", async () => {
    const [q] = await run([finding({ options: [{ label: "Bad", changes: [{ target: "term", id: "t1", field: "billing", value: "x" }] }, YES, NO], suggestion: { option: 0, reason: "r" } })]);
    expect(q!.options.map((o) => o.label)).toEqual([YES.label, NO.label]);
    expect(q!.suggestion).toBeNull();
  });

  it("creates a term for a missed rule from the finding", async () => {
    const [q] = await run([
      finding({
        type: "missed_rule", about: { target: "none", id: null }, quote: "Screen failure",
        newTerm: { category: "deadline", name: "Payment deadline", amount: null, unit: null, billing: "unknown", trigger: "invoice received", formula: null, conditions: null, deadline: "45 days", notes: null },
        options: [{ label: "ignored", changes: [] }],
        suggestion: { option: 0, reason: "It affects cash flow." },
      }),
    ]);
    expect(q!.options.map((o) => o.label)).toEqual(["Add it to the rulebook", "No, leave the rulebook as it is"]);
    expect(q!.options[0]!.patches).toEqual([
      {
        target: "term", id: "rv_0",
        set: expect.objectContaining({
          id: "rv_0", category: "deadline", name: "Payment deadline", amountCents: null, deadline: "45 days", evidence: "none", houseRuleIds: [],
          source: { doc: "CTA.pdf", page: 1, quote: "Screen failure" },
        }),
      },
    ]);
    expect(q!.suggestion).toEqual({ option: 0, reason: "It affects cash flow." });
  });

  it("gives a missed rule an id no existing term has", async () => {
    const newTerm = { category: "deadline" as const, name: "Payment deadline", amount: null, unit: null, billing: "unknown" as const, trigger: null, formula: null, conditions: null, deadline: "45 days", notes: null };
    const [q] = await run([finding({ type: "missed_rule", newTerm })], rulebook({ terms: [term({}), term({ id: "rv_0" })] }));
    expect(q!.options[0]!.patches[0]!.id).toBe("rv_0_2");
  });

  it("converts a new term's amount, and falls back to the finding's own options when the term is invalid", async () => {
    const base = { category: "site_fee" as const, name: "Archive fee", unit: null, billing: "invoice" as const, trigger: null, formula: null, conditions: null, deadline: null, notes: null };
    const [ok, bad] = await run([
      finding({ type: "missed_rule", newTerm: { ...base, amount: "$1,250.00" } }),
      finding({ type: "missed_rule", newTerm: { ...base, amount: "a fee" }, options: [{ label: "No, leave it as it is", changes: [] }, YES] }),
    ]);
    expect((ok!.options[0]!.patches[0]!.set as { amountCents: number }).amountCents).toBe(125000);
    expect(bad!.options).toEqual([{ label: "No, leave it as it is", patches: [] }, { label: YES.label, patches: [] }]);
  });
});
