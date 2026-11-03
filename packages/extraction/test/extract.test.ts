import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rulebook } from "@dct/shared";
import * as mupdf from "mupdf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContractChecks } from "../src/checks";
import { type Clients, CONFIG, extractStudy, extractWith, gridMismatches, identifyDocuments, identifyWith, type InputDoc, isNonContent, scrub } from "../src/extract";
import { renderPage } from "../src/index";
import type { CostEntry, LlmClient, LlmRequest } from "../src/llm";
import { AiPages, type AiGrid, type AiTerms } from "../src/prompts";
import { pageCount, renderTiles } from "../src/render";
import { readTextLayer, type TextPage, type Word } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/** 3-page synthetic PDF: portrait text-ish page, a landscape "grid" page, a blank page. */
function syntheticPdf(): string {
  const doc = new mupdf.PDFDocument();
  const boxes = "0 0 0 rg 72 700 300 20 re f 72 650 400 10 re f";
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, boxes));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 90, {}, "0 0 0 rg 50 50 500 5 re f 50 100 500 5 re f"));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, ""));
  const path = join(mkdtempSync(join(tmpdir(), "dct-extract-")), "synthetic.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

const pdf = syntheticPdf();
const docs: InputDoc[] = [{ id: "d1", filename: "synthetic.pdf", path: pdf, kind: null }];

function aiTermsFrom(rb: Rulebook): AiTerms {
  const { schemaVersion, budgetGrids, governingGridId, ...t } = rb;
  return { ...t, notes: [{ kind: "ambiguous", topic: "overhead on stipends", path: "/overhead/appliesTo", source: { documentId: "d1", page: 1 } }] };
}
function aiGridFrom(rb: Rulebook): AiGrid {
  const { id, ...g } = rb.budgetGrids[0]!;
  return { ...g, procedures: g.procedures.map((p) => ({ ...p, cells: Object.entries(p.cells).map(([visit, value]) => ({ visit, value })) })) };
}

type Seen = { name: string; labels: string[]; maxBytes: number };
function mockClient(provider: CostEntry["provider"], rb: Rulebook, seen: Seen[] = []): LlmClient {
  let calls = 0;
  return {
    provider,
    model: `mock-${provider}`,
    cost: () => ({ provider, model: `mock-${provider}`, inputTokens: calls * 1000, outputTokens: calls * 100, usd: calls * 0.01 }),
    async call<T>(req: LlmRequest<T>): Promise<T> {
      calls++;
      seen.push({ name: req.name, labels: req.images.map((i) => i.label), maxBytes: Math.max(...req.images.map((i) => i.png.length)) });
      const out =
        req.name === "classify"
          ? {
              pages: [
                { page: 1, kind: "terms", readable: true, rotation: 0, gridGroup: null },
                { page: 2, kind: "budget_grid", readable: true, rotation: 270, gridGroup: "Exhibit A" },
                { page: 3, kind: "boilerplate", readable: false, rotation: 0, gridGroup: null },
              ],
            }
          : req.name.startsWith("terms")
            ? aiTermsFrom(rb)
            : req.name === "grid"
              ? { grids: [aiGridFrom(rb)] }
              : { documents: [{ id: "d1", kind: "work_order", title: "WO", date: null }], studyGuess: { sponsor: "Acme Bio", protocol: "ACM-100", siteName: null, investigator: null } };
      return req.schema.parse(out);
    },
  };
}

describe("rendering", () => {
  it("counts pages, renders PNG, tiles a page within the size limit", async () => {
    expect(await pageCount(pdf)).toBe(3);
    const png = await renderPage(pdf, 1, 72);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    const tiles = await renderTiles(pdf, 2, { dpi: 400, rotate: 90, maxPx: 2000 });
    expect(tiles.length).toBeGreaterThan(1);
    for (const t of tiles) expect(Math.max(t.box[2] - t.box[0], t.box[3] - t.box[1])).toBeLessThanOrEqual(2000);
    await expect(renderPage(pdf, 9)).rejects.toThrow(/out of range/);
  });
});

describe("extractWith (mocked AI)", () => {
  // These exercise the full cross-read (grids too) with an OpenAI-priced mock; budget and
  // terms-only cross-reads have their own tests below.
  const saved = { maxUsd: CONFIG.maxUsd, crossGrids: CONFIG.crossGrids };
  beforeEach(() => Object.assign(CONFIG, { maxUsd: 100, crossGrids: true }));
  afterEach(() => Object.assign(CONFIG, saved));
  it("classifies, reads terms + tiled grid, assembles a valid rulebook and cross-checks it", async () => {
    const rb = makeRulebook();
    const crossRb = structuredClone(rb);
    crossRb.payment.netDays.value = 30;
    const seen: Seen[] = [];
    const clients: Clients = { primary: mockClient("anthropic", rb, seen), cross: mockClient("openai", crossRb) };
    const progress: number[] = [];
    const out = await extractWith({ documents: docs, onProgress: (p) => progress.push(p) }, clients);

    expect(Rulebook.parse(out.rulebook)).toBeTruthy();
    expect(out.rulebook.budgetGrids[0]!.id).toBe("g1");
    expect(out.rulebook.budgetGrids[0]!.procedures[0]!.cells).toEqual({ V1: 30000, V2: 30000 });
    expect(out.crossRead).not.toBeNull();
    expect(out.rulebook.payment.netDays.prov.crossCheck).toBe("disagree");
    expect(out.rulebook.overhead.pct.prov.crossCheck).toBe("agree");
    expect(out.rulebook.payment.netDays.prov.method).toBe("ai");
    expect(out.pages).toEqual([
      { documentId: "d1", page: 1, kind: "terms", readable: true },
      { documentId: "d1", page: 2, kind: "budget_grid", readable: true },
      { documentId: "d1", page: 3, kind: "boilerplate", readable: false },
    ]);
    expect(out.cost.map((c) => c.provider)).toEqual(["anthropic", "openai"]);
    expect(progress.at(-1)).toBe(100);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);

    // Grid page re-rendered at high DPI as tiles + overview; term pages exclude grid and unreadable pages.
    const grid = seen.find((s) => s.name === "grid")!;
    expect(grid.labels[0]).toBe("documentId d1, page 2, overview");
    expect(grid.labels.filter((l) => l.includes("tile")).length).toBeGreaterThan(1);
    expect(seen.find((s) => s.name === "terms")!.labels).toEqual(["documentId d1, page 1", "documentId d1, page 2"]); // grid pages carry clauses too

    const codes = runContractChecks(out.rulebook, { crossRead: out.crossRead, pages: out.pages, notes: out.notes }).map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(["AI_DISAGREEMENT", "UNREADABLE_PAGE", "AMBIGUOUS_TERM"]));
  });

  it("takes the quantity and row total the grid read says a row prints out of the rulebook, as printedRows for the binder", async () => {
    const rb = makeRulebook();
    const base = mockClient("anthropic", rb);
    const primary: LlmClient = {
      ...base,
      async call<T>(req: LlmRequest<T>): Promise<T> {
        const out = await base.call(req);
        if (req.name === "grid") {
          const p = (out as unknown as { grids: { procedures: Record<string, unknown>[] }[] }).grids[0]!.procedures;
          Object.assign(p[0]!, { printedQty: 2, printedRowTotalCents: 60000 });
          Object.assign(p[1]!, { printedQty: null });
        }
        return out;
      },
    };
    const out = await extractWith({ documents: docs }, { primary, cross: null });
    expect(out.printedRows).toEqual([{ grid: 0, procedure: 0, qty: 2, totalCents: 60000 }]);
    // never in the rulebook
    expect(JSON.stringify(out.rulebook)).not.toMatch(/printedQty|printedRowTotalCents/);
    expect(Rulebook.parse(out.rulebook)).toBeTruthy();
    // a read that gives none has none
    expect((await extractWith({ documents: docs }, { primary: mockClient("anthropic", rb), cross: null })).printedRows).toBeUndefined();
  });

  it("skips the cross-read without an OpenAI client, and survives a cross-read failure", async () => {
    const rb = makeRulebook();
    const solo = await extractWith({ documents: docs }, { primary: mockClient("anthropic", rb), cross: null });
    expect(solo.crossRead).toBeNull();
    expect(solo.cost).toHaveLength(1);
    expect(solo.rulebook.payment.netDays.prov.crossCheck).toBe("not_checked");
    expect(solo.warnings).toEqual([{ kind: "cross_read_off", text: "The cross-read is off (CROSS_READ=off, or no key)." }]);

    const broken = mockClient("openai", rb);
    broken.call = async () => {
      throw new Error("boom");
    };
    const out = await extractWith({ documents: docs }, { primary: mockClient("anthropic", rb), cross: broken });
    expect(out.crossRead).toBeNull();
    expect(out.warnings).toEqual([{ kind: "cross_read_failed", text: "The cross-read failed: boom" }]);
  });

  it("says by kind what made the reading weaker, in its own words: a re-read that failed or was skipped", async () => {
    const rb = makeRulebook();
    rb.budgetGrids[0]!.visits[0]!.totalCents = 89000; // its parts add up to 840.00: a misread digit, so the grid is re-read
    const failing = mockClient("anthropic", rb);
    const call = failing.call.bind(failing);
    failing.call = (req) => (req.name === "grid-reread" ? Promise.reject(new Error("the answer was cut off")) : call(req));
    const off = { kind: "cross_read_off", text: "The cross-read is off (CROSS_READ=off, or no key)." };
    expect((await extractWith({ documents: docs }, { primary: failing, cross: null })).warnings).toEqual([
      { kind: "grid_reread_failed", grid: 1, text: "The re-read of budget grid 1 failed, so the first read was kept: the answer was cut off" },
      off,
    ]);
    CONFIG.maxUsd = 0.2; // under what the re-read is estimated to cost
    expect((await extractWith({ documents: docs }, { primary: mockClient("anthropic", rb), cross: null })).warnings).toEqual([
      { kind: "grid_reread_skipped", grid: 1, text: "Budget grid 1: 1 total(s) don't add up; the re-read was skipped to stay within the $0.20 limit." },
      off,
    ]);
  });

  it("stops before the next AI call once its signal aborts, and gives every call the signal", async () => {
    const stop = new AbortController();
    const seen: Seen[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const c = mockClient("anthropic", makeRulebook(), seen);
    const call = c.call.bind(c);
    c.call = (req) => (signals.push(req.signal), req.name === "classify" && stop.abort(), call(req));
    await expect(extractWith({ documents: docs, signal: stop.signal }, { primary: c, cross: mockClient("anthropic", makeRulebook()) })).rejects.toThrow(/aborted/);
    expect(seen.map((x) => x.name)).toEqual(["classify"]);
    expect(signals).toEqual([stop.signal]);
  });

  it("scrubs bank-like content and fixes unknown document ids", async () => {
    const rb = makeRulebook();
    rb.payment.invoiceAddress.value = "Pay to account 123456789012";
    rb.payment.netDays.prov.source = { documentId: "nope", page: 1, quote: "wire to ABA routing number on file" };
    rb.payment.netDaysFrom.value = "receipt of invoice; refunds to GB82 WEST 1234 5698 7654 32 or 1234-5678-9012";
    rb.payment.paymentConditions.value = ["Wire via Deutsche Bank, SWIFT DEUTDEFF", "eCRFs complete by 2025-08-22"];
    rb.overhead.pct.prov.source = { documentId: "d1", page: 1, location: "Exhibit B, bank account no. 12345678" };
    const out = await extractWith({ documents: docs }, { primary: mockClient("anthropic", rb), cross: null });
    expect(out.rulebook.payment.invoiceAddress.value).toBe("Pay to account [redacted]");
    expect(out.rulebook.payment.netDays.prov.source).toEqual({ documentId: "d1", page: 1 });
    // IBANs and grouped digit runs go wherever they are; a string about a bank with a code in it goes whole; dates stay
    expect(out.rulebook.payment.netDaysFrom.value).toBe("receipt of invoice; refunds to [redacted] or [redacted]");
    expect(out.rulebook.payment.paymentConditions.value).toEqual(["[redacted]", "eCRFs complete by 2025-08-22"]);
    expect(out.rulebook.overhead.pct.prov.source!.location).toBe("[redacted]");
  });

  it("paints bank details over in the images it sends (text pages)", async () => {
    const doc = new mupdf.PDFDocument();
    const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
    const text = [
      "Payee bank ABA routing 021000021, account 123456789.",
      "This page continues the agreement between the parties and the site, as set out above in full detail.",
      "A second ordinary line of words keeps this page well above the threshold for a real text layer.",
    ];
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, text.map((t, i) => `BT /F1 10 Tf 40 ${732 - 20 * i} Td (${t}) Tj ET\n`).join("")));
    const file = join(mkdtempSync(join(tmpdir(), "dct-extract-")), "bank.pdf");
    writeFileSync(file, doc.saveToBuffer("").asUint8Array());
    const sent: { name: string; png: Buffer }[] = [];
    const c = mockClient("anthropic", makeRulebook());
    const call = c.call.bind(c);
    c.call = (req) => (req.images.forEach((i) => sent.push({ name: req.name, png: i.png })), call(req));
    await extractWith({ documents: [{ id: "d1", filename: "bank.pdf", path: file, kind: null }] }, { primary: c, cross: null });
    const [page] = await readTextLayer(file, "d1");
    const account = page!.words.find((w) => w.text === "123456789.")!.rect;
    for (const s of sent.filter((x) => x.name === "classify" || x.name === "terms")) {
      const pix = new mupdf.Image(s.png).toPixmap();
      const k = pix.getWidth() / 612; // the page is 612 pt wide
      const [x0, y0, x1, y1] = account.map((v) => Math.round(v * k)) as [number, number, number, number];
      const px = pix.getPixels();
      for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) expect(px[y * pix.getStride() + x]).toBeLessThan(10);
    }
    expect(sent.some((x) => x.name === "terms")).toBe(true);
  });

  it("identifyWith scrubs bank details from the guess it gives back (stored on the study and in the audit log)", async () => {
    const c = mockClient("anthropic", makeRulebook());
    const guess = { sponsor: "Acme Bio, account 123456789012", protocol: "ACM-100", siteName: "Pay to IBAN GB82 WEST 1234 5698 7654 32", investigator: null };
    c.call = async (req) => req.schema.parse({ documents: [{ id: "d1", kind: "work_order", title: "WO", date: null }], studyGuess: guess });
    expect((await identifyWith(docs, c)).studyGuess).toEqual({ sponsor: "Acme Bio, account [redacted]", protocol: "ACM-100", siteName: "[redacted]", investigator: null });
  });

  it("takes a grid's total for several patients out of its per-patient totals, into a note the checks show", async () => {
    const rb = makeRulebook();
    rb.budgetGrids[0]!.perPatientTotals.push({ label: "Estimated total (50 patients)", cents: 50 * 140000, prov: rb.budgetGrids[0]!.prov });
    const out = await extractWith({ documents: docs }, { primary: mockClient("anthropic", rb), cross: mockClient("anthropic", rb) });
    expect(out.rulebook.budgetGrids[0]!.perPatientTotals.map((t) => t.cents)).toEqual([140000]);
    expect(out.crossRead!.budgetGrids[0]!.perPatientTotals.map((t) => t.cents)).toEqual([140000]);
    expect(out.notes.filter((n) => n.kind === "estimate")).toEqual([{ kind: "estimate", topic: "Estimated total (50 patients)", path: "/budgetGrids/0", source: { documentId: "d1", page: 3 }, estimate: { cents: 7000000, patients: 50, perPatientCents: 140000 } }]);
    expect(runContractChecks(out.rulebook, { notes: out.notes }).filter((a) => /PER_PATIENT|ESTIMATE/.test(a.code)).map((a) => `${a.code} ${a.path}`)).toEqual(["MULTI_PATIENT_ESTIMATE /budgetGrids/0"]);
  });

  it("identifyWith keeps a protocol number printed in hyphenated digit groups (the confirm screen's guess)", async () => {
    const c = mockClient("anthropic", makeRulebook());
    const guess = { sponsor: "Acme Bio", protocol: "AB-1234-567-8901", siteName: "Site, Tel: 919-555-0142", investigator: null };
    c.call = async (req) => req.schema.parse({ documents: [{ id: "d1", kind: "work_order", title: "WO", date: null }], studyGuess: guess });
    expect((await identifyWith(docs, c)).studyGuess).toEqual(guess);
  });

  it("keeps protocol and phone numbers in every string of the read, and scrubs the notes too", async () => {
    const rb = makeRulebook();
    rb.study.protocol.value = "AB-1234-567-8901";
    rb.referencedDocuments = [{ description: "Exhibit A - Protocol AB-1234-567-8901", date: null, present: false, prov: rb.study.protocol.prov }];
    rb.payment.netDays.prov.source = { documentId: "d1", page: 1, quote: "Questions about invoices: call 919-555-0142 or fax +44 20 7946 0958" };
    const c = mockClient("anthropic", rb);
    const call = c.call.bind(c);
    // a note is the model's text too: it becomes an anomaly's message, stored and shown
    c.call = async (req) => {
      const out = (await call(req)) as { notes?: unknown[] };
      if (req.name === "terms") out.notes = [{ kind: "ambiguous", topic: "refunds to account 123456789012", path: null, source: { documentId: "d1", page: 1, quote: "wire to 1234-5678-9012" } }];
      return out as never;
    };
    const out = await extractWith({ documents: docs }, { primary: c, cross: null });
    expect(out.rulebook.study.protocol.value).toBe("AB-1234-567-8901");
    expect(out.rulebook.referencedDocuments[0]!.description).toBe("Exhibit A - Protocol AB-1234-567-8901");
    expect(out.rulebook.payment.netDays.prov.source!.quote).toBe("Questions about invoices: call 919-555-0142 or fax +44 20 7946 0958");
    expect(out.notes).toEqual([{ kind: "ambiguous", topic: "refunds to account [redacted]", path: null, source: { documentId: "d1", page: 1, quote: "[redacted]" } }]);
  });

  it("identifyWith keeps known kinds and fills the rest", async () => {
    const res = await identifyWith([...docs, { ...docs[0]!, id: "d2", kind: "amendment" }], mockClient("anthropic", makeRulebook()));
    expect(res.documentKinds).toEqual({ d1: "work_order", d2: "amendment" });
    expect(res.studyGuess.protocol).toBe("ACM-100");
  });
});

describe("EXTRACTION_FAKE=1", () => {
  afterEach(() => {
    delete process.env.EXTRACTION_FAKE;
  });
  it("returns the synthetic fixture mapped onto the caller's documents", async () => {
    process.env.EXTRACTION_FAKE = "1";
    const input: InputDoc[] = [
      { id: "a", filename: "x.pdf", path: "/nonexistent/x.pdf", kind: null },
      { id: "b", filename: "y.pdf", path: "/nonexistent/y.pdf", kind: "budget" },
    ];
    const id = await identifyDocuments(input);
    expect(id.documentKinds).toEqual({ a: "work_order", b: "budget" });
    const out = await extractStudy({ documents: input });
    expect(Rulebook.parse(out.rulebook).documents.map((d) => d.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(out)).not.toMatch(/doc-1|doc-2/);
    const codes = new Set(runContractChecks(out.rulebook, { crossRead: out.crossRead, pages: out.pages, notes: out.notes }).map((a) => a.code));
    for (const c of ["GRID_CONFLICT", "MISSING_REFERENCED_DOC", "AI_DISAGREEMENT", "REQUIRED_MISSING", "UNREADABLE_PAGE", "AMBIGUOUS_TERM"]) expect(codes).toContain(c);
    // the fake read's grid row and invoiceable share a name: a scheduled-visit price and a separate one, not a duplicate (ADR-002)
    expect(codes).not.toContain("DUPLICATE_ITEM");
  });
});

describe("cost cap ($20 per contract, on real spend)", () => {
  it("stops before the next AI call once what was spent reaches the cap", async () => {
    const seen: Seen[] = [];
    const saved = CONFIG.maxUsd;
    CONFIG.maxUsd = 0.02; // the mock spends $0.01 a call
    try {
      await expect(extractWith({ documents: docs }, { primary: mockClient("anthropic", makeRulebook(), seen), cross: null })).rejects.toThrow(/has spent \$0.02, the \$0.02 limit for one read/);
    } finally {
      CONFIG.maxUsd = saved;
    }
    expect(seen.map((x) => x.name)).toEqual(["classify", "terms"]);
  });

  it("bounds each call's output tokens by its kind", async () => {
    const limits: Record<string, number | undefined> = {};
    const c = mockClient("anthropic", makeRulebook());
    const call = c.call.bind(c);
    c.call = (req) => ((limits[req.name] = req.maxTokens), call(req));
    await extractWith({ documents: docs }, { primary: c, cross: null });
    expect(limits).toMatchObject({ classify: 8_000, terms: 32_000, grid: 64_000 });
  });

  it("by default the cross-reader reads terms only, not budget grids", async () => {
    const seenP: Seen[] = [];
    const seenC: Seen[] = [];
    const rb = makeRulebook();
    const out = await extractWith({ documents: docs }, { primary: mockClient("anthropic", rb, seenP), cross: mockClient("anthropic", structuredClone(rb), seenC) });
    expect(seenP.some((x) => x.name === "grid")).toBe(true);
    expect(seenC.map((x) => x.name).sort()).toEqual(["terms", "terms-items", "terms-payment"]);
    expect(out.crossRead!.budgetGrids).toEqual([]);
  });
});

describe("gridMismatches (triggers a max-effort re-read)", () => {
  const visit = (code: string, sub: number, oh: number, np: number, total: number) => ({ code, name: code, order: 1, procedureSubtotalCents: sub, overheadCents: oh, nonProcedureCents: np, totalCents: total, autopay: true, prov: { source: null, confidence: 1, method: "ai" as const, crossCheck: "not_checked" as const } });
  const proc = (cat: "procedure" | "non_procedure", cells: [string, number][]) => ({ code: null, name: "x", unitCents: null, overheadApplied: true, category: cat, cells: cells.map(([visit, value]) => ({ visit, value })), prov: { source: null, confidence: 1, method: "ai" as const, crossCheck: "not_checked" as const } });
  const grid = (visits: ReturnType<typeof visit>[], procedures: ReturnType<typeof proc>[]) =>
    ({ label: "g", arm: null, statedOverheadPct: 40, visits, procedures, perPatientTotals: [], header: { investigator: null, siteName: null }, prov: { source: null, confidence: 1, method: "ai" as const, crossCheck: "not_checked" as const } }) as never;

  it("counts visits whose totals or cells don't add up, within $1", () => {
    const ok = grid([visit("V1", 50000, 20000, 10000, 80000)], [proc("procedure", [["V1", 50000]]), proc("non_procedure", [["V1", 10000]])]);
    expect(gridMismatches([ok])).toBe(0);
    const misreadTotal = grid([visit("V1", 50000, 20000, 10000, 89000)], []);
    expect(gridMismatches([misreadTotal])).toBe(1);
    const misreadCell = grid([visit("V1", 50000, 20000, 10000, 80000)], [proc("procedure", [["V1", 58000]]), proc("non_procedure", [["V1", 10000]])]);
    expect(gridMismatches([misreadCell])).toBe(1);
  });
});

/** A synthetic PDF of text pages (each long enough to count as a real text layer). */
function textPdf(pages: string[]): string {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const filler = "This page continues the agreement between the parties as set out above in full detail and without change.";
  for (const first of pages) {
    const lines = [first, filler, filler, filler];
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, lines.map((t, i) => `BT /F1 9 Tf 40 ${732 - 20 * i} Td (${t}) Tj ET\n`).join("")));
  }
  const path = join(mkdtempSync(join(tmpdir(), "dct-extract-")), "text.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

type Classed = { page: number; kind: string; readable?: boolean; gridGroup?: string | null }[];
/** A mock whose classifier returns the given pages. */
function classifying(pages: Classed, seen: Seen[]): LlmClient {
  const c = mockClient("anthropic", makeRulebook(), seen);
  const call = c.call.bind(c);
  c.call = (req) => (req.name === "classify" ? Promise.resolve(req.schema.parse({ pages: pages.map((p) => ({ readable: true, rotation: 0, gridGroup: null, ...p })) }) as never) : call(req));
  return c;
}

describe("pages that aren't read (e-signature records and notices, reference lists)", () => {
  const input = (path: string): InputDoc[] => [{ id: "d1", filename: "text.pdf", path, kind: null }];
  const saved = { maxUsd: CONFIG.maxUsd };
  beforeEach(() => Object.assign(CONFIG, { maxUsd: 100 }));
  afterEach(() => Object.assign(CONFIG, saved));

  it("sends them to neither the terms read nor a grid read, and lists them in a warning", async () => {
    const path = textPdf(["Payment terms of the agreement.", "Certificate of completion, signers and timestamps.", "Notice about electronic records, consent and paper copies.", "Appendix: a list of product codes."]);
    const seen: Seen[] = [];
    const out = await extractWith(
      { documents: input(path) },
      { primary: classifying([{ page: 1, kind: "terms" }, { page: 2, kind: "esign_certificate" }, { page: 3, kind: "esign_disclosure" }, { page: 4, kind: "reference_appendix" }], seen), cross: null },
    );
    expect(seen.find((s) => s.name === "terms")!.labels).toEqual(["documentId d1, page 1"]);
    expect(out.pages.map((p) => p.kind)).toEqual(["terms", "esign_certificate", "esign_disclosure", "reference_appendix"]);
    const w = out.warnings.find((x) => x.kind === "pages_excluded")!;
    expect(w.kind === "pages_excluded" && w.pages.map((p) => [p.filename, p.page, p.kind, p.money])).toEqual([
      ["text.pdf", 2, "esign_certificate", false],
      ["text.pdf", 3, "esign_disclosure", false],
      ["text.pdf", 4, "reference_appendix", false],
    ]);
  });

  it("trusts the label of a page with a dollar amount, and the warning marks it", async () => {
    const path = textPdf(["Payment terms of the agreement.", "Certificate of completion. Start-up fee $1,500.00 per site."]);
    const seen: Seen[] = [];
    const out = await extractWith({ documents: input(path) }, { primary: classifying([{ page: 1, kind: "terms" }, { page: 2, kind: "esign_certificate" }], seen), cross: null });
    // the classifier's label rules (ADR-002): the page isn't read, but nobody can miss that it prints an amount
    expect(seen.find((s) => s.name === "terms")!.labels).toEqual(["documentId d1, page 1"]);
    const w = out.warnings.find((x) => x.kind === "pages_excluded")!;
    expect(w.kind === "pages_excluded" && w.pages).toEqual([{ documentId: "d1", filename: "text.pdf", page: 2, kind: "esign_certificate", money: true }]);
  });

  it("doesn't mark a reference page of percentages and codes as printing an amount: only money-like figures count", async () => {
    const path = textPdf(["Payment terms of the agreement.", "Reference table. Code 99213 applies to 45% of subjects and code 36415 to 12.5% of visits, in 3 of 16 arms."]);
    const out = await extractWith({ documents: input(path) }, { primary: classifying([{ page: 1, kind: "terms" }, { page: 2, kind: "reference_appendix" }], []), cross: null });
    const w = out.warnings.find((x) => x.kind === "pages_excluded")!;
    expect(w.kind === "pages_excluded" && w.pages.map((p) => p.money)).toEqual([false]);
    expect(w.text).not.toMatch(/print an amount/);
  });

  it("reads everything when every page would be excluded (a read of nothing loses the contract)", async () => {
    const path = textPdf(["Certificate of completion.", "Notice about electronic records."]);
    const seen: Seen[] = [];
    const out = await extractWith({ documents: input(path) }, { primary: classifying([{ page: 1, kind: "esign_certificate" }, { page: 2, kind: "esign_disclosure" }], seen), cross: null });
    expect(seen.find((s) => s.name === "terms")!.labels).toEqual(["documentId d1, page 1", "documentId d1, page 2"]);
    expect(out.pages.map((p) => p.kind)).toEqual(["terms", "terms"]);
    expect(out.warnings.some((x) => x.kind === "pages_excluded")).toBe(false);
  });

  it("splits budget grids by the arm or cohort key the classifier gives, ignoring case and spacing", async () => {
    const path = textPdf(["Budget one.", "Budget two.", "Budget three.", "Budget four."]);
    const seen: Seen[] = [];
    await extractWith(
      { documents: input(path) },
      { primary: classifying([{ page: 1, kind: "budget_grid", gridGroup: "Arm De Novo" }, { page: 2, kind: "budget_grid", gridGroup: "arm  de novo" }, { page: 3, kind: "budget_grid", gridGroup: "Arm: Rollover" }, { page: 4, kind: "budget_grid", gridGroup: "Arm: Rollover" }], seen), cross: null },
    );
    const grids = seen.filter((s) => s.name === "grid").map((s) => [...new Set(s.labels.map((l) => /page (\d)/.exec(l)![1]))].join(","));
    expect(grids.sort()).toEqual(["1,2", "3,4"]);
  });

  it("says a scan's excluded pages could not be checked for amounts (money null), where a text page says true or false", async () => {
    const seen: Seen[] = [];
    const out = await extractWith({ documents: docs }, { primary: classifying([{ page: 1, kind: "terms" }, { page: 2, kind: "esign_certificate" }, { page: 3, kind: "terms" }], seen), cross: null });
    const w = out.warnings.find((x) => x.kind === "pages_excluded")!;
    expect(w.kind === "pages_excluded" && w.pages.map((p) => p.money)).toEqual([null]); // the synthetic pages have no text and SCAN_OCR=0: nothing could read them
    expect(w.text).toContain("could not be checked for amounts");
    const text = textPdf(["Payment terms.", "Certificate of completion."]);
    const out2 = await extractWith({ documents: input(text) }, { primary: classifying([{ page: 1, kind: "terms" }, { page: 2, kind: "esign_certificate" }], seen), cross: null });
    const w2 = out2.warnings.find((x) => x.kind === "pages_excluded")!;
    expect(w2.kind === "pages_excluded" && w2.pages.map((p) => p.money)).toEqual([false]);
  });

  it("reads the excluded kinds as terms when no page of a read kind is left (a signature page alone doesn't carry a contract), and says so", async () => {
    const path = textPdf(["Signature page.", "Certificate of completion.", "Notice about electronic records.", "Appendix: product codes."]);
    const seen: Seen[] = [];
    const out = await extractWith(
      { documents: input(path) },
      { primary: classifying([{ page: 1, kind: "signatures" }, { page: 2, kind: "esign_certificate" }, { page: 3, kind: "esign_disclosure" }, { page: 4, kind: "reference_appendix" }], seen), cross: null },
    );
    expect(out.pages.map((p) => p.kind)).toEqual(["signatures", "terms", "terms", "terms"]);
    expect(seen.find((s) => s.name === "terms")!.labels).toEqual(["documentId d1, page 2", "documentId d1, page 3", "documentId d1, page 4"]);
    expect(out.warnings.some((x) => x.kind === "pages_excluded")).toBe(false);
    const w = out.warnings.find((x) => x.kind === "exclusion_overridden")!;
    expect(w.kind === "exclusion_overridden" && w.pages.map((p) => [p.page, p.kind])).toEqual([[2, "esign_certificate"], [3, "esign_disclosure"], [4, "reference_appendix"]]);
  });

  it("keeps a budget_grid page's own kind when that fallback fires (an unreadable one doesn't count as left to read)", async () => {
    const path = textPdf(["Budget.", "Certificate of completion."]);
    const out = await extractWith({ documents: input(path) }, { primary: classifying([{ page: 1, kind: "budget_grid", readable: false, gridGroup: "Arm A" }, { page: 2, kind: "esign_certificate" }], []), cross: null });
    expect(out.pages.map((p) => p.kind)).toEqual(["budget_grid", "terms"]);
    expect(out.warnings.some((x) => x.kind === "exclusion_overridden")).toBe(true);
  });

  it("keeps symbols in the arm key: '>=18' and '<18', 'Arm A' and 'Arm A+' are different grids; case and spacing aren't", async () => {
    const path = textPdf(["One.", "Two.", "Three.", "Four.", "Five.", "Six."]);
    const seen: Seen[] = [];
    await extractWith(
      { documents: input(path) },
      {
        primary: classifying([
          { page: 1, kind: "budget_grid", gridGroup: "Part A (>=18)" }, { page: 2, kind: "budget_grid", gridGroup: "Part A (<18)" },
          { page: 3, kind: "budget_grid", gridGroup: "Arm A" }, { page: 4, kind: "budget_grid", gridGroup: "Arm A+" },
          { page: 5, kind: "budget_grid", gridGroup: "arm a" }, { page: 6, kind: "budget_grid", gridGroup: "Arm  A" },
        ], seen),
        cross: null,
      },
    );
    const grids = seen.filter((s) => s.name === "grid").map((s) => [...new Set(s.labels.map((l) => /page (\d)/.exec(l)![1]))].join(","));
    expect(grids.sort()).toEqual(["1", "2", "3", "4", "5,6"]);
  });

  it("still accepts the kinds stored before the exclusion kinds, including boilerplate", () => {
    for (const kind of ["terms", "budget_grid", "invoiceables", "signatures", "boilerplate"]) expect(AiPages.parse({ pages: [{ page: 1, kind, readable: true, rotation: 0, gridGroup: null }] }).pages[0]!.kind).toBe(kind);
  });
});

describe("a page with nothing to read (a blank separator or cover sheet), told from its own words", () => {
  const word = (text: string, y: number, conf?: number): Word => ({ text, rect: [72, y, 120, y + 10], dir: 0, block: 0, line: 0, hidden: false, ...(conf !== undefined ? { conf } : {}) });
  const page = (words: Word[], over: Partial<TextPage> = {}): TextPage => ({ documentId: "d1", page: 1, width: 612, height: 792, source: "text", words, hidden: 0, largePicture: false, ...over });
  const few = ["Study", "binder", "section", "divider"].map((t, i) => word(t, 300 + 12 * i));

  it("is non-content: fewer than ten words outside the header and footer, no digit, no table or picture; a page number in the footer doesn't count", () => {
    expect(isNonContent(page([]))).toBe(true);
    expect(isNonContent(page(few))).toBe(true);
    expect(isNonContent(page([...few, word("Page 7", 760), word("Confidential 2026", 20)]))).toBe(true);
    expect(isNonContent(page(few.map((w) => ({ ...w })), { source: "ocr" }))).toBe(true); // our own OCR's words, all read with confidence
    expect(isNonContent(page(few.map((w) => ({ ...w, conf: 0.95 })), { source: "ocr" }))).toBe(true);
  });

  it("is read when unsure: ten words, a digit, a money word or sign, a table, a picture, hidden text, unread ink, a scan without our OCR, unsure OCR words", () => {
    const ten = Array.from({ length: 10 }, (_, i) => word(`word${i === 0 ? "" : "x".repeat(i)}`, 100 + 12 * i));
    expect(isNonContent(page(ten))).toBe(false);
    expect(isNonContent(page([...few, word("Schedule 2", 400)]))).toBe(false);
    expect(isNonContent(page([...few, word("No", 400), word("holdback", 412), word("applies", 424)]))).toBe(false); // a term the sweep must see
    expect(isNonContent(page([...few, word("Fee", 400)]))).toBe(false);
    expect(isNonContent(page([...few, word("$", 400)]))).toBe(false);
    expect(isNonContent(page([...few, word("5%", 760)]))).toBe(false); // not even in the footer
    expect(isNonContent(page(few, { grids: [{ box: [0, 0, 10, 10], xs: [0, 10], ys: [0, 10] }] }))).toBe(false);
    expect(isNonContent(page(few, { largePicture: true }))).toBe(false);
    expect(isNonContent(page(few, { hidden: 2 }))).toBe(false);
    expect(isNonContent(page(few, { drawn: true }))).toBe(false);
    expect(isNonContent(page(few, { source: "ocr", unread: [{ documentId: "d1", page: 1, box: [0.1, 0.1, 0.1, 0.1] }] }))).toBe(false);
    expect(isNonContent(page(few.map((w) => ({ ...w, conf: 0.5 })), { source: "ocr" }))).toBe(false);
    for (const source of ["image_only", "ocr_layer"] as const) expect(isNonContent(page([], { source }))).toBe(false);
    expect(isNonContent(undefined)).toBe(false);
  });

  it("a blank page in a PDF is excluded like the other kinds, never sent to a model, and listed in the warning", async () => {
    const doc = new mupdf.PDFDocument();
    const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
    const filler = "This page continues the agreement between the parties as set out above in full detail and without change.";
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, ["Payment terms of the agreement.", filler, filler, filler].map((t, i) => `BT /F1 9 Tf 40 ${732 - 20 * i} Td (${t}) Tj ET\n`).join("")));
    // a page with under 200 characters reads as a scan (textPage), which only our OCR's words can vouch for: these are few words, long
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, [400, 380].map((y) => `BT /F1 9 Tf 40 ${y} Td (${Array(4).fill("abcdefghijklmnopqrstuvwxyz").join(" ")}) Tj ET\n`).join("")));
    const path = join(mkdtempSync(join(tmpdir(), "dct-extract-")), "sparse.pdf");
    writeFileSync(path, doc.saveToBuffer("").asUint8Array());
    const seen: Seen[] = [];
    const out = await extractWith({ documents: [{ id: "d1", filename: "sparse.pdf", path, kind: null }] }, { primary: classifying([{ page: 1, kind: "terms" }, { page: 2, kind: "terms" }], seen), cross: null });
    expect(seen.find((x) => x.name === "terms")!.labels).toEqual(["documentId d1, page 1"]);
    expect(out.pages.map((p) => p.kind)).toEqual(["terms", "non_content"]);
    const w = out.warnings.find((x) => x.kind === "pages_excluded")!;
    expect(w.kind === "pages_excluded" && w.pages.map((p) => [p.page, p.kind, p.money])).toEqual([[2, "non_content", false]]);
  });
});

describe("scrub", () => {
  it("keeps protocol, trial and phone numbers, dates and amounts outside a string about a bank", () => {
    const kept = [
      // protocol and study ids: hyphens, letters and digits, slashes, dots, underscores
      "AB-1234-567-8901",
      "Exhibit A - Protocol AB-1234-567-8901",
      "ABC-1234-5678-901",
      "CTRI/2020/01/012345",
      "NL12345.078.18",
      "STUDY_2023_00001234",
      "XY12345678Z",
      "2402T1432, BHV3000-315, J2A-MC-GZGI, CA209-8HW",
      "NCT05123456 and IND 123456",
      // trial registry numbers: EU CT (yyyy-nnnnnn-nn and its CTIS form), EudraCT
      "EU CT number 2024-500123-45",
      "2023-503456-12-00",
      "EudraCT 2019-001234-56",
      // phone and fax numbers, national and international
      "Tel: 555-014-2011",
      "Fax (555) 014-2011",
      "1-800-555-1234",
      "+1 555 014 2011",
      "+44 20 7946 0958",
      "+33 1 23 45 67 89",
      "+49 30 12345678",
      "+91 98765 43210",
      "+86 13812345678",
      "Phone: 5550142011",
      "Tel. +61 2 5550 1234",
      "555.014.2011",
      // amounts and dates
      "US$ 123,450.00",
      "Estimated total $1,234,500.00",
      "EUR 1.234.567,00 and 12 345 678,90",
      "Visits 1 2 3 4 5 6 7 8 9 10",
      "eCRFs complete by 2025-08-22",
      "Wire transfers received by 2025-08-22 are applied that month",
    ];
    for (const s of kept) expect(scrub(s)).toBe(s);
  });

  it("redacts unbroken runs and IBANs anywhere, grouped runs in a string about a bank, and a bank string whole", () => {
    // unbroken: how account, routing and card numbers print, bank word or not
    expect(scrub("021000021")).toBe("[redacted]");
    expect(scrub("Reference 123456789012")).toBe("Reference [redacted]");
    expect(scrub("Pay to account 123456789012")).toBe("Pay to account [redacted]");
    expect(scrub("ABA routing 021000021")).toBe("[redacted]");
    // a phone label doesn't keep a run longer than a phone number can be, nor one printed after it
    expect(scrub("Phone 1234567890123456")).toBe("Phone [redacted]");
    expect(scrub("Tel +1 555 014 2011 123456789")).toBe("Tel +1 555 014 2011 [redacted]");
    // a card number, grouped by spaces or hyphens, goes with no bank word near it (13 to 19 digits passing Luhn)
    expect(scrub("Card 4111 1111 1111 1111 on file")).toBe("Card [redacted] on file");
    expect(scrub("Paid with 5500-0000-0000-0004")).toBe("Paid with [redacted]");
    expect(scrub("Ref 3782 822463 10005")).toBe("Ref [redacted]");
    // the same length failing Luhn is a reference number, kept like a protocol id outside a bank string
    expect(scrub("Ref 4111 1111 1111 1112")).toBe("Ref 4111 1111 1111 1112");
    // IBANs, whole or grouped, and a grouped run beside one
    expect(scrub("GB82 WEST 1234 5698 7654 32")).toBe("[redacted]");
    expect(scrub("DE89370400440532013000")).toBe("[redacted]");
    expect(scrub("refunds to GB82 WEST 1234 5698 7654 32 or 1234-5678-9012")).toBe("refunds to [redacted] or [redacted]");
    // grouped as banks print them, beside a bank word
    expect(scrub("Account: 1234-5678-9012")).toBe("Account: [redacted]");
    expect(scrub("Account 1234 5678 9012")).toBe("Account [redacted]");
    expect(scrub("Sort code 12-34-56, account 12345678")).toBe("Sort code 12-34-56, account [redacted]");
    expect(scrub("Wire to 1234 5678 9012")).toBe("[redacted]");
    expect(scrub("ACH 12-3456-7890123-00")).toBe("[redacted]");
    expect(scrub("Remit to 0210-0002-1 / 1234.5678.90")).toBe("[redacted]");
    expect(scrub("Bank account no. 12-345-678-9")).toBe("[redacted]");
    // a tax id, as today: an investigator's may be a social security number
    expect(scrub("Tax ID#: 12-3456789")).toBe("Tax ID#: [redacted]");
    expect(scrub("Tax ID/VAT or GST Registration/TIN/SSN 123-45-6789")).toBe("Tax ID/VAT or GST Registration/TIN/SSN [redacted]");
    expect(scrub("The Institution's tax identification number is: 12-3456789.")).toBe("The Institution's tax identification number is: [redacted].");
    expect(scrub("12-3456789")).toBe("[redacted]"); // printed under its label, on a line of its own
    expect(scrub("123-45-6789")).toBe("[redacted]");
    // a phone number in a string about a bank is not kept: the string is the bank's
    expect(scrub("Bank of Example, tel +1 555 014 2011")).toBe("[redacted]");
    expect(scrub("Wire via Deutsche Bank, SWIFT DEUTDEFF")).toBe("[redacted]");
  });
});
