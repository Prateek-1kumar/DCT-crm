import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rulebook } from "@dct/shared";
import * as mupdf from "mupdf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContractChecks } from "../src/checks";
import { type Clients, CONFIG, extractStudy, extractWith, gridMismatches, identifyDocuments, identifyWith, type InputDoc } from "../src/extract";
import { renderPage } from "../src/index";
import type { CostEntry, LlmClient, LlmRequest } from "../src/llm";
import type { AiGrid, AiTerms } from "../src/prompts";
import { pageCount, renderTiles } from "../src/render";
import { readTextLayer } from "../src/textlayer";
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
    for (const c of ["GRID_CONFLICT", "MISSING_REFERENCED_DOC", "DUPLICATE_ITEM", "AI_DISAGREEMENT", "REQUIRED_MISSING", "UNREADABLE_PAGE", "AMBIGUOUS_TERM"]) expect(codes).toContain(c);
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
