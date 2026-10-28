import { type DocumentKind, Rulebook } from "@dct/shared";
import type { ZodType } from "zod";
import { compareRulebooks, type ExtractionNote, type PageInfo, printedAmounts, provAt } from "./checks";
import { fakeExtract, fakeIdentify } from "./fake";
import { clientsFromEnv, type CostEntry, type Image, type LlmClient, type LlmRequest, priceOf } from "./llm";
import { type AiGrid, AiGrids, AiIdentify, AiPages, type AiTerms, AiTermsItems, AiTermsPayment, AiTermsStudy, classifyPrompt, gridPrompt, identifyPrompt, SYSTEM, termsPrompt } from "./prompts";
import { dpiToFit, type PageRect, pageCount, pageText, RENDER_LIMITS, renderPng, renderTiles, type Rotation, tileLayout } from "./render";
import { bankRects, readTextLayer } from "./textlayer";

export type InputDoc = { id: string; filename: string; path: string; kind: DocumentKind | null };

export type ExtractionOutput = {
  /** Primary read (Claude). */
  rulebook: Rulebook;
  /** Second, independent read (OpenAI); null if unavailable. */
  crossRead: Rulebook | null;
  pages: PageInfo[];
  cost: CostEntry[];
  /** Extra (not in PHASE-1 interface): ambiguity / retroactive notes the schema can't hold yet. Pass to runContractChecks. */
  notes: ExtractionNote[];
  /** Extra: non-fatal problems, e.g. cross-read failed. */
  warnings: string[];
};

/** primary reads (Sonnet), fast sorts pages and identifies documents (Haiku; falls back to primary), cross re-reads (OpenAI). */
export type Clients = { primary: LlmClient; cross: LlmClient | null; fast?: LlmClient | null };

// Claude's vision input tops out at 2576 px long edge and ~3.75 MP; anything larger is downscaled
// server-side, which would throw away the high-DPI render. Keep every image under both.
export const CONFIG = {
  classifyMaxPx: 1000,
  identifyMaxPx: 1400,
  /** Letter page at 2150 px long edge ≈ 3.6 MP (identify/manual uses). */
  pageMaxPx: 2150,
  /** Terms pages: Claude's recommended 1568 px long edge (~1.6K tokens/page vs ~4.8K at 2150); contract text stays legible. */
  termsMaxPx: 1568,
  /** Runaway cap on real spend per extraction, all providers (ADR-001 §11; user decision 2026-10-28: $20 per contract). */
  maxUsd: Number(process.env.EXTRACTION_MAX_USD) || 20,
  /** Output tokens (thinking included) one call may use: page sorting is short, a dense grid is long. */
  maxOutputTokens: { classify: 8_000, identify: 8_000, terms: 32_000, grid: 64_000 },
  /** Send budget grids to the cross-reader too. Off: grids are verified by arithmetic, and grid cross-reads were most of the cost. */
  crossGrids: process.env.CROSS_READ_GRIDS === "1",
  pageMaxDpi: 300,
  gridOverviewMaxPx: 1600,
  /** Grid pages are re-rendered at this DPI and tiled (dense, sideways tables need 400+). */
  gridDpi: Number(process.env.EXTRACTION_GRID_DPI) || 400,
  /** Square tiles: 1900² ≈ 3.6 MP. */
  tileMaxPx: 1900,
  concurrency: 3,
  /** Cost/resource caps: exceeding one fails the extraction with a clear error instead of running up AI cost. */
  maxPagesPerDoc: 100,
  /** Across all documents of one study; checked before any rendering or AI call. */
  maxPagesTotal: 200,
  maxTilesPerExtraction: 60,
  /** Every image sent to a model in one extraction (classification + terms + grid overviews + tiles), or in one identify call. */
  maxImagesPerExtraction: 300,
  /** DPI clamp, pixel budget and tiles-per-page (shared with renderPage). */
  render: RENDER_LIMITS,
};

export class ExtractionLimitError extends Error {}

/** Counts usage against a cap and throws *before* the work that would exceed it. */
function budget(cap: number, what: string) {
  let used = 0;
  return {
    take(n: number) {
      if (used + n > cap) throw new ExtractionLimitError(`This extraction needs more than ${cap} ${what} (limit); split the upload or raise the limit in CONFIG`);
      used += n;
    },
  };
}

/** Page counts per document, enforcing the per-document and total page caps. Opens files only; renders nothing. */
async function countPages(documents: InputDoc[]): Promise<number[]> {
  const counts = await Promise.all(documents.map((d) => pageCount(d.path)));
  documents.forEach((d, i) => {
    if (counts[i]! > CONFIG.maxPagesPerDoc) throw new ExtractionLimitError(`${d.filename} has ${counts[i]} pages; the limit is ${CONFIG.maxPagesPerDoc} per document`);
  });
  const total = counts.reduce((a, b) => a + b, 0);
  if (total > CONFIG.maxPagesTotal) throw new ExtractionLimitError(`The study's documents have ${total} pages in total; the limit is ${CONFIG.maxPagesTotal}`);
  return counts;
}

const fake = () => process.env.EXTRACTION_FAKE === "1";

function envClients(): Clients {
  const { primary, fast, cross } = clientsFromEnv();
  if (!primary) throw new Error("ANTHROPIC_API_KEY is not set. Set it in .env, or set EXTRACTION_FAKE=1 to use the synthetic fixture.");
  return { primary, fast, cross };
}

const label = (documentId: string, page: number, extra = "") => `documentId ${documentId}, page ${page}${extra ? `, ${extra}` : ""}`;

/** Bank details on each text page (documentId#page → areas), painted over in every image a model gets (ADR-001 §9). */
type Masks = Map<string, PageRect[]>;
async function bankMasks(documents: InputDoc[]): Promise<Masks> {
  const pages = (await Promise.all(documents.map((d) => readTextLayer(d.path, d.id)))).flat();
  return new Map(pages.map((p) => [`${p.documentId}#${p.page}`, bankRects(p)]));
}

async function pageImage(doc: InputDoc, page: number, maxPx: number, masks: Masks, rotate: Rotation = 0, capDpi = CONFIG.pageMaxDpi): Promise<Image> {
  const dpi = await dpiToFit(doc.path, page, maxPx, capDpi);
  return { label: label(doc.id, page), png: await renderPng(doc.path, page, { dpi, rotate, gray: true, mask: masks.get(`${doc.id}#${page}`) }) };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- identify

export async function identifyDocuments(docs: InputDoc[]) {
  if (fake()) return fakeIdentify(docs);
  const c = envClients();
  return identifyWith(docs, c.fast ?? c.primary);
}

export async function identifyWith(docs: InputDoc[], llm: LlmClient) {
  const counts = (await countPages(docs)).map((n) => Math.min(3, n));
  budget(CONFIG.maxImagesPerExtraction, "page images").take(counts.reduce((a, b) => a + b, 0));
  const masks = await bankMasks(docs);
  const images: Image[] = [];
  for (const [i, d] of docs.entries()) for (let p = 1; p <= counts[i]!; p++) images.push(await pageImage(d, p, CONFIG.identifyMaxPx, masks));
  const res = await llm.call({ name: "identify", system: SYSTEM, prompt: identifyPrompt(docs), images, schema: AiIdentify, effort: "low", maxTokens: CONFIG.maxOutputTokens.identify });
  const documentKinds: Record<string, DocumentKind> = {};
  for (const d of docs) documentKinds[d.id] = d.kind ?? res.documents.find((x) => x.id === d.id)?.kind ?? "other";
  return { documentKinds, studyGuess: res.studyGuess };
}

// ---------------------------------------------------------------- extract

export async function extractStudy(input: { documents: InputDoc[]; onProgress?: (pct: number, step: string) => void }): Promise<ExtractionOutput> {
  if (fake()) return fakeExtract(input);
  return extractWith(input, envClients());
}

type ClassifiedPage = PageInfo & { rotation: Rotation; gridGroup: string | null };

export async function extractWith(
  { documents, onProgress }: { documents: InputDoc[]; onProgress?: (pct: number, step: string) => void },
  given: Clients,
): Promise<ExtractionOutput> {
  const progress = (pct: number, step: string) => onProgress?.(Math.round(pct), step);
  const warnings: string[] = [];
  if (!documents.length) throw new Error("extractStudy: no documents");

  // Runaway cap on what was really spent: checked before every model call. ponytail: calls already in flight (a few, run in
  // parallel) can each still finish, so the overshoot is at most their cost. Upgrade: reserve each call's worst case first.
  const spent = () => [...new Set([given.primary, given.fast, given.cross])].reduce((n, c) => n + (c ? c.cost().usd : 0), 0);
  const capped = (c: LlmClient): LlmClient => ({
    ...c,
    async call<T>(req: LlmRequest<T>): Promise<T> {
      if (spent() >= CONFIG.maxUsd)
        throw new ExtractionLimitError(`This read has spent $${spent().toFixed(2)}, the $${CONFIG.maxUsd.toFixed(2)} limit per contract, so it was stopped before the next AI call`);
      return c.call(req);
    },
  });
  const clients: Clients = { primary: capped(given.primary), cross: given.cross && capped(given.cross), fast: given.fast && capped(given.fast) };

  // 0. Caps first: nothing is rendered or sent until the page counts are within limits.
  const counts = await countPages(documents);
  const images = budget(CONFIG.maxImagesPerExtraction, "page images");
  const tiles = budget(CONFIG.maxTilesPerExtraction, "grid image tiles");
  images.take(counts.reduce((a, b) => a + b, 0));
  const masks = await bankMasks(documents);

  // 1. Classify every page (low-res, upright or not).
  progress(2, "Rendering pages");
  const pages: ClassifiedPage[] = (
    await pool(documents, CONFIG.concurrency, async (doc) => {
      const n = counts[documents.indexOf(doc)]!;
      const images = [];
      for (let p = 1; p <= n; p++) images.push(await pageImage(doc, p, CONFIG.classifyMaxPx, masks));
      const res = await (clients.fast ?? clients.primary).call({ name: "classify", system: SYSTEM, prompt: classifyPrompt(doc.id, doc.filename, n), images, schema: AiPages, effort: "low", maxTokens: CONFIG.maxOutputTokens.classify });
      return Array.from({ length: n }, (_, i): ClassifiedPage => {
        const r = res.pages.find((x) => x.page === i + 1);
        // A page the classifier skipped is read as terms rather than silently dropped.
        return { documentId: doc.id, page: i + 1, kind: r?.kind ?? "terms", readable: r?.readable ?? true, rotation: r?.rotation ?? 0, gridGroup: r?.gridGroup ?? null };
      });
    })
  ).flat();
  progress(15, `Classified ${pages.length} pages`);

  // 2. Render what each read needs, once, shared by both providers.
  const docOf = new Map(documents.map((d) => [d.id, d]));
  const readable = pages.filter((p) => p.readable);
  // Grid pages go to the terms reader too: a page often holds a budget table AND contract clauses
  // (Shah p.3: budget summary + overhead, holdback, net-45 and overpayment clauses).
  let termPages = readable.filter((p) => p.kind === "terms" || p.kind === "invoiceables" || p.kind === "budget_grid");
  if (!termPages.length) termPages = readable;
  images.take(termPages.length);
  const termImages = await Promise.all(termPages.map((p) => pageImage(docOf.get(p.documentId)!, p.page, CONFIG.termsMaxPx, masks, p.rotation)));

  const groups: ClassifiedPage[][] = [];
  for (const p of readable.filter((x) => x.kind === "budget_grid")) {
    const last = groups.at(-1)?.at(-1);
    const continues = last && last.documentId === p.documentId && last.page === p.page - 1 && last.gridGroup !== null && last.gridGroup === p.gridGroup;
    if (continues) groups.at(-1)!.push(p);
    else groups.push([p]);
  }
  // Tile layout is computed and charged to the budgets before any pixmap is allocated.
  const gridImages: Image[][] = [];
  for (const g of groups) {
    const imgs: Image[] = [];
    for (const p of g) {
      const doc = docOf.get(p.documentId)!;
      const opts = { dpi: CONFIG.gridDpi, rotate: p.rotation, maxPx: CONFIG.tileMaxPx, gray: true, mask: masks.get(`${doc.id}#${p.page}`) };
      const layout = await tileLayout(doc.path, p.page, opts);
      tiles.take(layout.count);
      images.take(layout.count + (layout.count > 1 ? 1 : 0));
      const pageTiles = await renderTiles(doc.path, p.page, { ...opts, maxTiles: layout.count });
      if (pageTiles.length > 1) imgs.push({ ...(await pageImage(doc, p.page, CONFIG.gridOverviewMaxPx, masks, p.rotation)), label: label(doc.id, p.page, "overview") });
      for (const t of pageTiles) imgs.push({ label: label(doc.id, p.page, pageTiles.length > 1 ? `tile row ${t.row + 1}/${t.rows} column ${t.col + 1}/${t.cols}` : ""), png: t.png });
    }
    gridImages.push(imgs);
  }
  progress(25, `Reading ${termPages.length} term pages and ${groups.length} budget grid(s)`);

  // Optional steps (grid re-reads) only run while the running total plus their estimate stays under the cap.
  const est = estimateUsd(clients, termImages, gridImages);
  const crossGrids = CONFIG.crossGrids;

  // 3. Independent reads.
  const totalCalls = 1 + groups.length + (clients.cross ? 1 + (crossGrids ? groups.length : 0) : 0);
  let done = 0;
  const tick = (step: string) => progress(25 + (70 * ++done) / totalCalls, step);
  const read = async (llm: LlmClient) => {
    const isPrimary = llm === clients.primary;
    const who = isPrimary ? "primary" : "cross-check";
    // The first terms call writes the image cache; the other two then read it at ~10% of the price.
    const termsCall = <T>(name: string, part: "study" | "payment" | "items", schema: ZodType<T>) =>
      llm.call({ name, system: SYSTEM, prompt: termsPrompt(documents, part), images: termImages, schema, effort: isPrimary ? "medium" : "low", cacheImages: true, maxTokens: CONFIG.maxOutputTokens.terms });
    const termsP = termsCall("terms", "study", AiTermsStudy)
      .then((study) => Promise.all([termsCall("terms-payment", "payment", AiTermsPayment), termsCall("terms-items", "items", AiTermsItems)]).then(([payment, items]) => ({ ...study, ...payment, ...items })))
      .then((t): AiTerms => (tick(`Read contract terms (${who})`), t));
    const gridsP = pool(isPrimary || crossGrids ? groups : [], CONFIG.concurrency, async (g) => {
      const i = groups.indexOf(g);
      const readGrid = (effort: "medium" | "high") =>
        llm.call({
          name: effort === "high" ? "grid-reread" : "grid",
          system: SYSTEM,
          prompt: gridPrompt(g[0]!.documentId, g.map((p) => p.page), gridImages[i]!.some((x) => x.label.includes("tile"))),
          images: gridImages[i]!,
          schema: AiGrids,
          effort,
          maxTokens: CONFIG.maxOutputTokens.grid,
        });
      let res = await readGrid("medium");
      // Numbers that don't add up are usually a misread digit: re-read that grid once at max effort
      // (primary only) and keep whichever read adds up better. Costs extra only on those pages.
      // Only a few bad visits look like misread digits; when most visits fail it's a layout misreading
      // that a re-read won't fix (HCWC: 44 of 44), so skip the cost and let the checks raise it for review.
      const bad = gridMismatches(res.grids);
      const visits = res.grids.reduce((n, g) => n + g.visits.length, 0);
      const affordable = spent() + est.perGrid[i]! * 1.5 <= CONFIG.maxUsd;
      if (bad > 0 && bad <= Math.max(3, Math.ceil(visits * 0.25)) && isPrimary && !affordable)
        warnings.push(`Budget grid ${i + 1}: ${bad} total(s) don't add up; re-read skipped to stay within the $${CONFIG.maxUsd.toFixed(2)} budget`);
      if (bad > 0 && bad <= Math.max(3, Math.ceil(visits * 0.25)) && isPrimary && affordable) {
        tick(`Re-reading budget grid ${i + 1} (${bad} total(s) didn't add up)`);
        try {
          const again = await readGrid("high");
          if (gridMismatches(again.grids) < bad) res = again;
        } catch (e) {
          warnings.push(`Re-read of budget grid ${i + 1} failed, kept the first read: ${(e as Error).message}`);
        }
      }
      tick(`Read budget grid ${i + 1}/${groups.length} (${who})`);
      return res.grids;
    });
    const [terms, grids] = await Promise.all([termsP, gridsP]);
    return assemble(terms, grids.flat(), documents);
  };

  const [primary, cross] = await Promise.all([
    read(clients.primary),
    clients.cross
      ? read(clients.cross).catch((e: unknown) => {
          warnings.push(`Cross-read failed: ${(e as Error).message}`);
          return null;
        })
      : Promise.resolve(null),
  ]);
  if (!clients.cross) warnings.push("Cross-read off (CROSS_READ=off or no key)");
  if (spent() > CONFIG.maxUsd) warnings.push(`Cost $${spent().toFixed(2)} went over the $${CONFIG.maxUsd.toFixed(2)} budget (estimate was $${est.required.toFixed(2)})`);

  // 4. Mark each primary value agree/disagree with the second read.
  if (cross) markCrossCheck(primary.rulebook, cross.rulebook);
  // 5. Digital PDFs: keep the amounts printed in each page's own text, for TEXT_LAYER_MISMATCH. Free, no AI.
  const printed = await Promise.all(pages.map((p) => pageText(docOf.get(p.documentId)!.path, p.page).then(printedAmounts)));
  progress(100, "Extraction complete");

  return {
    rulebook: primary.rulebook,
    crossRead: cross?.rulebook ?? null,
    pages: pages.map(({ documentId, page, kind, readable }, i) => ({ documentId, page, kind, readable, ...(printed[i] && { printed: printed[i] }) })),
    cost: [clients.primary.cost(), ...(clients.fast ? [clients.fast.cost()] : []), ...(clients.cross ? [clients.cross.cost()] : [])],
    notes: primary.notes,
    warnings,
  };
}

/** Merge one provider's term + grid reads into a Rulebook that passes Rulebook.parse. */
export function assemble(terms: AiTerms, grids: AiGrid[], docs: InputDoc[]): { rulebook: Rulebook; notes: ExtractionNote[] } {
  const { notes, ...t } = terms;
  const documents = docs.map((d) => {
    const m = t.documents.find((x) => x.id === d.id);
    return { id: d.id, kind: d.kind ?? m?.kind ?? "other", title: m?.title ?? d.filename, date: m?.date ?? null };
  });
  const raw = {
    schemaVersion: 1,
    ...t,
    documents,
    budgetGrids: grids.map((g, i) => ({
      ...g,
      id: `g${i + 1}`,
      procedures: g.procedures.map((p) => ({ ...p, cells: Object.fromEntries(p.cells.map((c) => [c.visit, c.value])) })),
    })),
    governingGridId: null,
  };
  const ids = new Set(docs.map((d) => d.id));
  sanitize(raw, ids, docs.length === 1 ? docs[0]!.id : null);
  const cleanNotes = notes.map((n) => ({ ...n, source: n.source && ids.has(n.source.documentId) ? n.source : null }));
  return { rulebook: Rulebook.parse(raw), notes: cleanNotes };
}

const BANKISH = /\b(routing|aba|swift|iban|bic|account\s*(no|number|#)|acct|bank)\b/i;
/** An IBAN, printed whole or in groups of four. */
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
/** 8+ digits, whole or grouped by single spaces or hyphens (account, routing), but not an ISO date. */
const DIGIT_RUN = /\b(?!\d{4}-\d{2}-\d{2}\b)\d(?:[ -]?\d){7,}\b/g;
/** A SWIFT/BIC code: 4 bank letters, 2 country letters, 2 location characters, optional 3-character branch. */
const BIC = /\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/;

/** Long digit runs and IBANs go; a string about a bank that still carries an account or SWIFT code goes whole. */
export function scrub(s: string): string {
  const t = s.replace(IBAN, "[redacted]").replace(DIGIT_RUN, "[redacted]");
  return BANKISH.test(t) && (t.includes("[redacted]") || BIC.test(t)) ? "[redacted]" : t;
}

/**
 * Normalise provenance (method/crossCheck, unknown document ids) and scrub anything bank-like
 * the model may have copied despite instructions: long digit runs, and quotes mentioning bank details.
 */
function sanitize(v: unknown, ids: Set<string>, onlyId: string | null): void {
  if (Array.isArray(v)) return v.forEach((x, i) => (typeof x === "string" ? (v[i] = scrub(x)) : sanitize(x, ids, onlyId)));
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) {
    if (typeof x === "string" && k !== "id" && k !== "documentId") o[k] = scrub(x);
    else sanitize(x, ids, onlyId);
  }
  if ("method" in o && "crossCheck" in o && "confidence" in o) {
    o.method = "ai";
    o.crossCheck = "not_checked";
    const src = o.source as { documentId: string; quote?: string } | null;
    if (src && !ids.has(src.documentId)) {
      if (onlyId) src.documentId = onlyId;
      else o.source = null;
    }
    if (src?.quote && BANKISH.test(src.quote)) delete src.quote;
  }
}

function markCrossCheck(rb: Rulebook, cross: Rulebook) {
  for (const c of compareRulebooks(rb, cross)) {
    const p = provAt(rb, c.path);
    if (!p) continue;
    if (!c.agree) p.crossCheck = "disagree";
    else if (p.crossCheck !== "disagree") p.crossCheck = "agree";
  }
}

/** Visits whose printed numbers don't add up (total vs subtotals, subtotals vs grid cells), ±$1. */
export function gridMismatches(grids: AiGrid[]): number {
  let bad = 0;
  for (const g of grids) {
    for (const v of g.visits) {
      if (v.procedureSubtotalCents !== null && v.overheadCents !== null && Math.abs(v.procedureSubtotalCents + v.overheadCents + (v.nonProcedureCents ?? 0) - v.totalCents) > 100) {
        bad++;
        continue;
      }
      const cells = g.procedures.flatMap((p) => p.cells.filter((c) => c.visit === v.code && typeof c.value === "number").map((c) => ({ cat: p.category, cents: c.value as number })));
      const procedures = cells.filter((c) => c.cat === "procedure");
      if (!procedures.length || v.procedureSubtotalCents === null) continue;
      const printed = v.procedureSubtotalCents + (v.nonProcedureCents ?? 0);
      if (Math.abs(cells.reduce((n, c) => n + c.cents, 0) - printed) > 100) bad++;
    }
  }
  return bad;
}

/** Claude image tokens ≈ width × height / 750 (read from the PNG header). */
export function imageTokens(png: Buffer): number {
  return Math.ceil((png.readUInt32BE(16) * png.readUInt32BE(20)) / 750);
}

/**
 * Rough USD estimate of the required reads (terms + grids, primary + terms cross-read) and per grid.
 * Output allowances are generous on purpose: the check refuses up front rather than overspend.
 */
export function estimateUsd(clients: Clients, termImages: Image[], gridImages: Image[][]) {
  const price = (c: LlmClient | null | undefined) => (c && c.provider === "anthropic" ? priceOf(c.model) : null);
  const p = price(clients.primary) ?? priceOf("claude-sonnet-5-5");
  const termsTok = termImages.reduce((n, i) => n + imageTokens(i.png), 0) + 3000;
  // one cache write + two cache reads, ~6K output tokens per terms call
  const terms = (pr: { in: number; out: number; cacheWrite: number; cacheRead: number }) => (termsTok * (pr.cacheWrite + 2 * pr.cacheRead) + 3 * 6000 * pr.out) / 1e6;
  const perGrid = gridImages.map((imgs) => ((imgs.reduce((n, i) => n + imageTokens(i.png), 0) + 2000) * p.in + 15000 * p.out) / 1e6);
  const cp = price(clients.cross);
  const cross = clients.cross ? (cp ? terms(cp) : terms({ in: 5, out: 30, cacheWrite: 5, cacheRead: 5 })) : 0;
  const required = terms(p) + perGrid.reduce((a, b) => a + b, 0) + cross;
  return { required, perGrid };
}
