import { type BudgetGrid, type DocumentKind, isExcludedPage, Rulebook } from "@dct/shared";
import type { ZodType } from "zod";
import { compareRulebooks, type ExtractionNote, type PageInfo, printedAmounts, provAt, splitEstimates } from "./checks";
import { fakeExtract, fakeIdentify } from "./fake";
import { clientsFromEnv, type CostEntry, type Image, type LlmClient, type LlmRequest, priceOf, tokenText } from "./llm";
import { type AiGrid, AiGrids, AiGridsAnchored, AiIdentify, AiPages, type AiTerms, AiTermsItems, AiTermsPayment, AiTermsStudy, classifyPrompt, gridPrompt, identifyPrompt, SYSTEM, termsPrompt } from "./prompts";
import type { Anchor, PrintedRow } from "./binder";
import { dpiToFit, type PageRect, pageCount, pageText, RENDER_LIMITS, renderPng, renderTiles, type Rotation, tileLayout, uprightFrame } from "./render";
import { amounts, type TextPage, bankRects, KEYWORDS, readTextLayer } from "./textlayer";
import { readTextGrids, type TextGrid } from "./gridtext";
import { dropUnknownTokens, parseTokenId, tokensFor } from "./tokens";

export type InputDoc = { id: string; filename: string; path: string; kind: DocumentKind | null };

export type ExtractionOutput = {
  /** Primary read (Claude). */
  rulebook: Rulebook;
  /** Second, independent read (CROSS_READ: Haiku or OpenAI); null if off or failed. */
  crossRead: Rulebook | null;
  pages: PageInfo[];
  cost: CostEntry[];
  /** Extra (not in PHASE-1 interface): ambiguity / retroactive notes the schema can't hold yet. Pass to runContractChecks. */
  notes: ExtractionNote[];
  /** Extra: non-fatal problems, e.g. cross-read failed. */
  warnings: ReadWarning[];
  /** EXTRACTION_TOKEN_MAP on: the tokens the primary grid read named. Absent when the switch is off. */
  anchors?: Anchor[];
  /** EXTRACTION_TOKEN_MAP on: amounts the grid read called no fee (a claim; the sweep believes one only where its own rule agrees). */
  nonFee?: NonFee[];
  /** What the grid read says each row prints as its quantity and its own total (grid and procedure are indexes into the rulebook); for `bindEvidence` to check against the scan. Only rows that gave one. */
  printedRows?: PrintedRow[];
  /** ADR-003 P2: how many budget grids were read by code from the PDF's own text (their arithmetic closed), not by a model. */
  gridsFromText?: number;
};

/**
 * What made a reading weaker than usual. The API words each kind for the reviewer (apps/api jobs.ts `plainWarnings`), so
 * rewording `text` never loses one; `text` is the reading's own words, for the team (the audit log).
 */
export type ReadWarning = { text: string } & (
  | { kind: "grid_reread_skipped"; grid: number } // a grid's totals didn't add up, and re-reading it would pass the cost limit
  | { kind: "grid_reread_failed"; grid: number } // its first read was kept
  | { kind: "cross_read_failed" }
  | { kind: "cross_read_off" } // off by choice: CROSS_READ=off, or no key
  | { kind: "over_limit" } // the read cost more than CONFIG.maxUsd
  | { kind: "fake" } // EXTRACTION_FAKE=1
  // pages classed as an e-signature record or notice or a reference list: not read, not swept. `money`: the page prints a dollar
  // amount (the classifier can be wrong): from its own text, or our OCR's reading of a scan; null when neither could be checked
  | { kind: "pages_excluded"; pages: { documentId: string; filename: string; page: number; kind: string; money: boolean | null }[] }
  // every page was labelled an e-signature record, notice or reference list (or a cover/signature page was all that else remained), so these were read as terms anyway
  | { kind: "exclusion_overridden"; pages: { documentId: string; filename: string; page: number; kind: string }[] }
);

/** An amount the model said is no fee: the token's page and word, and why. */
export type NonFee = { documentId: string; page: number; word: number; why: string };

type ReadInput = { documents: InputDoc[]; onProgress?: (pct: number, step: string) => void; signal?: AbortSignal };

/** primary reads (Sonnet), fast sorts pages and identifies documents (Haiku; falls back to primary), cross re-reads (Haiku or OpenAI). */
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
  /** Tiles: a 45-page text PDF with 20 grid pages is 120 at six a page. The cost cap (`maxUsd`) is what bounds the spend. */
  maxTilesPerExtraction: 120,
  /** Every image sent to a model in one extraction (classification + terms + grid overviews + tiles), or in one identify call. */
  maxImagesPerExtraction: 300,
  /** ADR-002 PR 3, both off until the owner has measured them on real contracts (docs/phase-1/adr-002-pipeline-redesign.md). */
  /** The text/OCR pass's tokens go to the model beside each image, and the grid read names the token of each value. */
  tokenMap: process.env.EXTRACTION_TOKEN_MAP === "1",
  /** DPI clamp, pixel budget and tiles-per-page (shared with renderPage). */
  render: RENDER_LIMITS,
};

export class ExtractionLimitError extends Error {}

/** Counts usage against a cap and throws *before* the work that would exceed it. */
function budget(cap: number, what: string) {
  let used = 0;
  return {
    take(n: number) {
      if (used + n > cap) throw new ExtractionLimitError(`This read needs more than ${cap} ${what}, the limit for one read. Split the upload into smaller PDFs.`);
      used += n;
    },
  };
}

/** Page counts per document, enforcing the per-document and total page caps. Opens files only; renders nothing. */
async function countPages(documents: InputDoc[]): Promise<number[]> {
  const counts = await Promise.all(documents.map((d) => pageCount(d.path)));
  documents.forEach((d, i) => {
    if (counts[i]! > CONFIG.maxPagesPerDoc) throw new ExtractionLimitError(`${d.filename} has ${counts[i]} pages; the limit is ${CONFIG.maxPagesPerDoc} per document. Split it into smaller PDFs and upload those.`);
  });
  const total = counts.reduce((a, b) => a + b, 0);
  if (total > CONFIG.maxPagesTotal) throw new ExtractionLimitError(`The study's documents have ${total} pages in total; the limit is ${CONFIG.maxPagesTotal}.`);
  return counts;
}

const fake = () => process.env.EXTRACTION_FAKE === "1";

function envClients(): Clients {
  const { primary, fast, cross } = clientsFromEnv();
  if (!primary) throw new Error("ANTHROPIC_API_KEY is not set. Set it in .env, or set EXTRACTION_FAKE=1 to use the synthetic fixture.");
  return { primary, fast, cross };
}

/**
 * A page with nothing to read (ADR-002 §1.3: a blank separator, a cover sheet), told from the page's own words and never sent
 * to a model. Every one of these holds, and when unsure the page is read: the words are the PDF's own text or our OCR's (never a
 * scanner's text layer, and no OCR run is made for this); fewer than ten words outside the top and bottom 8% of the page
 * (header and footer); no digit among them and no "$" or "%" or money word anywhere on the page (a short "No holdback applies"
 * is a term the sweep must see); no table, no large picture, no hidden text, no vector drawing, no ink our OCR couldn't read; on
 * a scan, every word read with confidence (a page of specks gives low-confidence junk, and is read).
 */
export const NON_CONTENT_WORDS = 10;
const HEADER_FOOTER = 0.08;
export function isNonContent(p: TextPage | undefined): boolean {
  if (!p || (p.source !== "text" && p.source !== "ocr")) return false;
  if (p.largePicture || p.drawn || p.hidden || p.grids?.length || p.unread?.length || !(p.height > 0)) return false;
  const seen = p.words.filter((w) => !w.hidden && w.text.trim());
  if (p.source === "ocr" && seen.some((w) => (w.conf ?? 1) < 0.8)) return false;
  if (seen.some((w) => /[$%]/.test(w.text)) || KEYWORDS.money.test(seen.map((w) => w.text).join(" "))) return false;
  const body = seen.filter((w) => {
    const y = (w.rect[1] + w.rect[3]) / 2 / p.height;
    return y >= HEADER_FOOTER && y <= 1 - HEADER_FOOTER;
  });
  return body.length < NON_CONTENT_WORDS && !body.some((w) => /\d/.test(w.text));
}

const label = (documentId: string, page: number, extra = "") => `documentId ${documentId}, page ${page}${extra ? `, ${extra}` : ""}`;

/**
 * Bank details on each text page (documentId#page → areas), painted over in every image a model gets (ADR-001 §9).
 * `ocr`: scans too, from our OCR's words (the read; identifying documents sees a few first pages and stays fast).
 */
type Masks = Map<string, PageRect[]>;
const layersOf = (documents: InputDoc[], ocr: boolean) => Promise.all(documents.map((d) => readTextLayer(d.path, d.id, { ocr })));
const masksOf = (layers: TextPage[][]): Masks => new Map(layers.flat().map((p) => [`${p.documentId}#${p.page}`, bankRects(p)]));
async function bankMasks(documents: InputDoc[], ocr = false): Promise<Masks> {
  return masksOf(await layersOf(documents, ocr));
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
  sanitize(res, new Set(docs.map((d) => d.id)), null); // its guess is stored on the study and in the audit log
  const documentKinds: Record<string, DocumentKind> = {};
  for (const d of docs) documentKinds[d.id] = d.kind ?? res.documents.find((x) => x.id === d.id)?.kind ?? "other";
  return { documentKinds, studyGuess: res.studyGuess };
}

// ---------------------------------------------------------------- extract

/** `signal`: once it aborts, no further model call starts, and the one in flight is cancelled. */
export async function extractStudy(input: ReadInput): Promise<ExtractionOutput> {
  if (fake()) return fakeExtract(input);
  return extractWith(input, envClients());
}

type ClassifiedPage = PageInfo & { rotation: Rotation; gridGroup: string | null };

export async function extractWith({ documents, onProgress, signal }: ReadInput, given: Clients): Promise<ExtractionOutput> {
  const progress = (pct: number, step: string) => onProgress?.(Math.round(pct), step);
  const warnings: ReadWarning[] = [];
  if (!documents.length) throw new Error("There are no documents to read.");

  // Runaway cap on what was really spent: checked before every model call. ponytail: calls already in flight (a few, run in
  // parallel) can each still finish, so the overshoot is at most their cost. Upgrade: reserve each call's worst case first.
  const spent = () => [...new Set([given.primary, given.fast, given.cross])].reduce((n, c) => n + (c ? c.cost().usd : 0), 0);
  // A read stopped from outside (pg-boss gave up on its job) starts no further model call, and the one in flight is
  // cancelled through the same signal.
  const capped = (c: LlmClient): LlmClient => ({
    ...c,
    async call<T>(req: LlmRequest<T>): Promise<T> {
      signal?.throwIfAborted();
      if (spent() >= CONFIG.maxUsd)
        throw new ExtractionLimitError(`This read has spent $${spent().toFixed(2)}, the $${CONFIG.maxUsd.toFixed(2)} limit for one read, so it was stopped before the next AI call.`);
      return c.call({ ...req, signal });
    },
  });
  const clients: Clients = { primary: capped(given.primary), cross: given.cross && capped(given.cross), fast: given.fast && capped(given.fast) };

  // 0. Caps first: nothing is rendered or sent until the page counts are within limits.
  const counts = await countPages(documents);
  const images = budget(CONFIG.maxImagesPerExtraction, "page images");
  const tiles = budget(CONFIG.maxTilesPerExtraction, "grid image tiles");
  images.take(counts.reduce((a, b) => a + b, 0));
  // One read of every page's words: the bank masks and the token map come from it.
  const layers = await layersOf(documents, true);
  const masks = masksOf(layers);
  const textOf = new Map(layers.flat().map((p) => [`${p.documentId}#${p.page}`, p]));
  const clean = (t: string) => scrub(t) === t; // a word that looks like bank details is no token

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
  // A blank separator or cover sheet is told from the page's own words (isNonContent), whatever the classifier said of it.
  for (const p of pages) if (!isExcludedPage(p) && isNonContent(textOf.get(`${p.documentId}#${p.page}`))) p.kind = "non_content";
  progress(15, `Classified ${pages.length} pages`);

  // 2. Render what each read needs, once, shared by both providers.
  const docOf = new Map(documents.map((d) => [d.id, d]));
  // A label is trusted (ADR-002), but not when no page of a kind that is READ is left (terms, invoiceables, budget_grid): a cover
  // or signature page alone doesn't carry a contract, and a read of no pages would lose it. Then the pages of the three exclusion
  // kinds are read as terms (a budget_grid page keeps its own kind), and a warning says so.
  const reads = (p: ClassifiedPage) => p.readable && (p.kind === "terms" || p.kind === "invoiceables" || p.kind === "budget_grid");
  const excluded = pages.some(reads) ? pages.filter(isExcludedPage) : [];
  const overridden = (excluded.length ? [] : pages.filter(isExcludedPage)).map((p) => ({ p, was: p.kind }));
  for (const { p } of overridden) p.kind = "terms";
  const readable = pages.filter((p) => p.readable && !excluded.includes(p));
  // Grid pages go to the terms reader too: a page often holds a budget table AND contract clauses
  // (Shah p.3: budget summary + overhead, holdback, net-45 and overpayment clauses).
  let termPages = readable.filter((p) => p.kind === "terms" || p.kind === "invoiceables" || p.kind === "budget_grid");
  if (!termPages.length) termPages = readable;
  images.take(termPages.length);
  // The token map never goes with a terms page (ADR-002 PR 3, the senior's rule): every value that isn't a grid price stays
  // read by the model and checked by the PDF's text with neither seeing the other.
  const termImages = await Promise.all(termPages.map((p) => pageImage(docOf.get(p.documentId)!, p.page, CONFIG.termsMaxPx, masks, p.rotation)));

  const groups: ClassifiedPage[][] = [];
  for (const p of readable.filter((x) => x.kind === "budget_grid")) {
    const last = groups.at(-1)?.at(-1);
    // the key is the arm or cohort the table prices, so a different one starts a new group; case and spacing don't. Symbols do:
    // "Part A (>=18)" and "Part A (<18)", or "Arm A" and "Arm A+", are different arms.
    const key = (g: string | null) => g?.toLowerCase().replace(/\s+/g, " ").trim();
    const continues = last && last.documentId === p.documentId && last.page === p.page - 1 && !!key(last.gridGroup) && key(last.gridGroup) === key(p.gridGroup);
    if (continues) groups.at(-1)!.push(p);
    else groups.push([p]);
  }
  // Tile layout is computed and charged to the budgets before any pixmap is allocated.
  const gridImages: Image[][] = [];
  // ADR-003 P2: a native PDF's grids read by code from its own text. One whose arithmetic closes (gridtext.ts) replaces the
  // model's read of its pages, and no image of them is sent; a grid page it doesn't cover whole keeps the model's read,
  // and a text grid reaching into such a page is dropped, so no grid is read twice. A page any failed text grid touches is
  // never covered, even when another grid on it closes: the failed table is read by the model, with the rest of its page.
  const pagesOf = (t: TextGrid) => new Set(t.pages.map((p) => `${t.grid.prov.source!.documentId}#${p}`));
  const allText = layers.flatMap((l) => (l[0] ? readTextGrids(l, l[0].documentId) : []));
  const unsure = new Set(allText.filter((t) => t.failed.length).flatMap((t) => [...pagesOf(t)]));
  let textGrids = allText.filter((t) => !t.failed.length);
  const covered = new Set(textGrids.flatMap((t) => [...pagesOf(t)]).filter((k) => !unsure.has(k)));
  for (let i = groups.length - 1; i >= 0; i--) {
    const keys = groups[i]!.map((p) => `${p.documentId}#${p.page}`);
    if (keys.every((k) => covered.has(k))) groups.splice(i, 1);
    else textGrids = textGrids.filter((t) => !keys.some((k) => pagesOf(t).has(k)));
  }
  for (const g of groups) {
    const imgs: Image[] = [];
    for (const p of g) {
      const doc = docOf.get(p.documentId)!;
      const di = documents.indexOf(doc);
      const mask = masks.get(`${doc.id}#${p.page}`);
      const text = textOf.get(`${doc.id}#${p.page}`)!;
      const tokensIn = (to: (r: PageRect) => PageRect, s: number, segs: Parameters<typeof tokensFor>[6]) => (CONFIG.tokenMap ? { tokens: tokensFor(text, di, to, s, mask ?? [], clean, segs) } : {});
      const opts = { dpi: CONFIG.gridDpi, rotate: p.rotation, maxPx: CONFIG.tileMaxPx, gray: true, mask };
      const layout = await tileLayout(doc.path, p.page, opts);
      tiles.take(layout.count);
      images.take(layout.count + (layout.count > 1 ? 1 : 0));
      const pageTiles = await renderTiles(doc.path, p.page, { ...opts, maxTiles: layout.count });
      if (pageTiles.length > 1) imgs.push({ ...(await pageImage(doc, p.page, CONFIG.gridOverviewMaxPx, masks, p.rotation)), label: label(doc.id, p.page, "overview") });
      const frame = CONFIG.tokenMap ? await uprightFrame(doc.path, p.page, p.rotation) : null;
      for (const t of pageTiles)
        imgs.push({ label: label(doc.id, p.page, pageTiles.length > 1 ? `tile row ${t.row + 1}/${t.rows} column ${t.col + 1}/${t.cols}` : ""), png: t.png, ...(frame ? tokensIn(frame.to, layout.dpi / 72, [{ from: t.box, at: [0, 0] }]) : {}) });
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
      // the ids this call's images carry: the only ones the model may name (anything else is dropped, never trusted)
      const known = new Set(gridImages[i]!.flatMap((x) => x.tokens?.map((t) => t.id) ?? []));
      const gridSchema: ZodType<AiGridsAnchored> = CONFIG.tokenMap ? AiGridsAnchored : AiGrids;
      const readGrid = async (effort: "medium" | "high") => {
        const out = await llm.call({
          name: effort === "high" ? "grid-reread" : "grid",
          system: SYSTEM,
          prompt: gridPrompt(g[0]!.documentId, g.map((p) => p.page), gridImages[i]!.some((x) => x.label.includes("tile")), { tokens: CONFIG.tokenMap }),
          images: gridImages[i]!,
          schema: gridSchema,
          effort,
          maxTokens: CONFIG.maxOutputTokens.grid,
        });
        if (CONFIG.tokenMap) dropUnknownTokens(out, known);
        return out;
      };
      let res = await readGrid("medium");
      // Numbers that don't add up are usually a misread digit: re-read that grid once at max effort
      // (primary only) and keep whichever read adds up better. Costs extra only on those pages.
      // Only a few bad visits look like misread digits; when most visits fail it's a layout misreading
      // that a re-read won't fix (HCWC: 44 of 44), so skip the cost and let the checks raise it for review.
      const bad = gridMismatches(res.grids);
      const visits = res.grids.reduce((n, g) => n + g.visits.length, 0);
      const affordable = spent() + est.perGrid[i]! * 1.5 <= CONFIG.maxUsd;
      if (bad > 0 && bad <= Math.max(3, Math.ceil(visits * 0.25)) && isPrimary && !affordable)
        warnings.push({ kind: "grid_reread_skipped", grid: i + 1, text: `Budget grid ${i + 1}: ${bad} total(s) don't add up; the re-read was skipped to stay within the $${CONFIG.maxUsd.toFixed(2)} limit.` });
      if (bad > 0 && bad <= Math.max(3, Math.ceil(visits * 0.25)) && isPrimary && affordable) {
        tick(`Re-reading budget grid ${i + 1} (${bad} total(s) didn't add up)`);
        try {
          const again = await readGrid("high");
          if (gridMismatches(again.grids) < bad) res = again;
        } catch (e) {
          // llm.ts keeps the model's reply out of its errors' messages
          warnings.push({ kind: "grid_reread_failed", grid: i + 1, text: `The re-read of budget grid ${i + 1} failed, so the first read was kept: ${(e as Error).message}` });
        }
      }
      tick(`Read budget grid ${i + 1}/${groups.length} (${who})`);
      return res;
    });
    const [terms, grids] = await Promise.all([termsP, gridsP]);
    return assemble(terms, grids.flatMap((r) => r.grids), documents, grids.flatMap((r) => r.nonFee ?? []), textGrids.map((t) => t.grid));
  };

  const [primary, cross] = await Promise.all([
    read(clients.primary),
    clients.cross
      ? read(clients.cross).catch((e: unknown) => {
          warnings.push({ kind: "cross_read_failed", text: `The cross-read failed: ${(e as Error).message}` });
          return null;
        })
      : Promise.resolve(null),
  ]);
  if (!clients.cross) warnings.push({ kind: "cross_read_off", text: "The cross-read is off (CROSS_READ=off, or no key)." });
  if (spent() > CONFIG.maxUsd) warnings.push({ kind: "over_limit", text: `The read cost $${spent().toFixed(2)}, over the $${CONFIG.maxUsd.toFixed(2)} limit (estimated $${est.required.toFixed(2)}).` });

  // 4. Mark each primary value agree/disagree with the second read.
  if (cross) markCrossCheck(primary.rulebook, cross.rulebook);
  // 5. Digital PDFs: keep the amounts printed in each page's own text, for TEXT_LAYER_MISMATCH. Free, no AI.
  const printed = await Promise.all(pages.map((p) => pageText(docOf.get(p.documentId)!.path, p.page).then(printedAmounts)));
  // Said on the draft, so nobody takes a skipped page for a read one. A page whose own text prints an amount is marked.
  if (excluded.length) {
    // an amount printed like money (a currency mark, a thousands comma, two decimals), from the page's own text or our OCR
    // of the scan (read once above), never any number: a reference table of percentages and codes prints none. null when
    // the page has neither (a scan with no OCR here)
    const printsMoney = (p: ClassifiedPage): boolean | null => {
      const t = textOf.get(`${p.documentId}#${p.page}`);
      return t?.source === "text" || t?.source === "ocr" ? amounts(t.words.filter((w) => !w.hidden)).length > 0 : null;
    };
    const words = excluded.map((p) => ({ documentId: p.documentId, filename: docOf.get(p.documentId)!.filename, page: p.page, kind: p.kind, money: printsMoney(p) }));
    const [yes, unknown] = [words.filter((w) => w.money), words.filter((w) => w.money === null)];
    warnings.push({ kind: "pages_excluded", pages: words, text: `${words.length} page(s) classed as an e-signature record, an e-signature notice, a reference list or a blank separator or cover sheet were not read or swept${yes.length ? `; ${yes.length} of them print an amount` : ""}${unknown.length ? `; ${unknown.length} could not be checked for amounts` : ""}.` });
  }
  if (overridden.length) warnings.push({ kind: "exclusion_overridden", pages: overridden.map(({ p, was }) => ({ documentId: p.documentId, filename: docOf.get(p.documentId)!.filename, page: p.page, kind: was })), text: `${overridden.length} page(s) labelled as an e-signature record, notice, reference list or blank sheet were read as contract text, because no page of terms, items or budget was left to read.` });
  progress(100, "Extraction complete");

  return {
    rulebook: primary.rulebook,
    crossRead: cross?.rulebook ?? null,
    pages: pages.map(({ documentId, page, kind, readable }, i) => ({ documentId, page, kind, readable, ...(printed[i] && { printed: printed[i] }) })),
    cost: [clients.primary.cost(), ...(clients.fast ? [clients.fast.cost()] : []), ...(clients.cross ? [clients.cross.cost()] : [])],
    notes: primary.notes,
    warnings,
    ...(CONFIG.tokenMap ? { anchors: primary.anchors, nonFee: primary.nonFee } : {}),
    ...(primary.printedRows.length ? { printedRows: primary.printedRows } : {}),
    gridsFromText: textGrids.length,
  };
}

/** Merge one provider's term + grid reads into a Rulebook that passes Rulebook.parse. */
function assemble(terms: AiTerms, grids: AiGridsAnchored["grids"], docs: InputDoc[], marked: NonNullable<AiGridsAnchored["nonFee"]> = [], fromText: BudgetGrid[] = []): { rulebook: Rulebook; notes: ExtractionNote[]; anchors: Anchor[]; printedRows: PrintedRow[]; nonFee: NonFee[] } {
  const { notes, ...t } = terms;
  const documents = docs.map((d) => {
    const m = t.documents.find((x) => x.id === d.id);
    return { id: d.id, kind: d.kind ?? m?.kind ?? "other", title: m?.title ?? d.filename, date: m?.date ?? null };
  });
  const raw = {
    schemaVersion: 1,
    ...t,
    documents,
    budgetGrids: [
      ...grids.map(({ visitTokens: _v, ...g }, i) => ({
        ...g,
        id: `g${i + 1}`,
        procedures: g.procedures.map(({ printedQty: _q, printedRowTotalCents: _t, ...p }) => ({ ...p, cells: Object.fromEntries(p.cells.map((c) => [c.visit, c.value])) })),
      })),
      // read by code from the PDF's own text (ADR-003 P2): after the model's grids, so their indexes (anchors, printedRows) hold
      ...fromText.map((g, i) => ({ ...g, id: `t${i + 1}` })),
    ],
    governingGridId: null,
  };
  const ids = new Set(docs.map((d) => d.id));
  sanitize(raw, ids, docs.length === 1 ? docs[0]!.id : null);
  sanitize(notes, ids, null); // a note's topic and quote become anomaly text, stored and shown
  const cleanNotes = notes.map((n) => ({ ...n, source: n.source && ids.has(n.source.documentId) ? n.source : null }));
  // what the model said each value was read from (already limited to the ids it was given; the rulebook itself doesn't hold them)
  const anchor = (id: string, rest: Omit<Anchor, "documentId" | "page" | "word">): Anchor[] => {
    const t = parseTokenId(id);
    const doc = t && docs[t.doc];
    return t && doc ? [{ ...rest, documentId: doc.id, page: t.page, word: t.word }] : [];
  };
  const anchors = grids.flatMap((g, grid): Anchor[] => [
    ...g.procedures.flatMap((p, procedure) => p.cells.flatMap((c) => (c.source_token_id ? anchor(c.source_token_id, { grid, field: "cell", visit: c.visit, procedure }) : []))),
    ...(g.visitTokens ?? []).flatMap((t) => anchor(t.source_token_id, { grid, field: t.field, visit: t.visit, procedure: null })),
  ]);
  const printedRows = grids.flatMap((g, grid) => g.procedures.flatMap((p, procedure): PrintedRow[] => (p.printedQty != null || p.printedRowTotalCents != null ? [{ grid, procedure, qty: p.printedQty ?? null, totalCents: p.printedRowTotalCents ?? null }] : [])));
  const nonFee = marked.flatMap((m): NonFee[] => {
    const t = parseTokenId(m.source_token_id);
    const doc = t && docs[t.doc];
    return t && doc ? [{ documentId: doc.id, page: t.page, word: t.word, why: m.why }] : [];
  });
  // a total for several patients is no per-patient total: out of the grid, kept as a note the checks show as a notice
  const { rulebook, notes: estimates } = splitEstimates(Rulebook.parse(raw));
  return { rulebook, notes: [...cleanNotes, ...estimates], anchors, printedRows, nonFee };
}

/** A string naming one of these that still carries an account or SWIFT code goes whole. */
const BANKISH = /\b(routing|aba|swift|iban|bic|account\s*(no|number|#)|acct|bank|wire|ach|remit)\b/i;
/** A quote naming bank details is dropped. Not for "wire", "ACH" or "remit" alone: a payment clause names them beside its own terms, and a dropped quote is asked. */
const BANK_QUOTE = /\b(routing|aba|swift|iban|bic|account\s*(no|number|#)|acct|bank)\b/i;
/** A string about bank or tax details: a bank label word, as the image masks find them (any "account" too), a tax id's, or an IBAN in it. */
const bankOrTax = (s: string) => KEYWORDS.bankLabel.test(s) || /\b(?:remit|tax\s*id|tax\s+identification|tin|ssn|ein|social\s+security|taxpayer)\b/i.test(s) || s.search(IBAN) >= 0;
/** An IBAN, printed whole or in groups of four. */
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
/** 8+ digits in one unbroken run: how account, routing and card numbers print (an amount has its comma or its cents). */
const LONG_RUN = /\b\d{8,}\b/g;
/**
 * 8+ digits in groups joined by single spaces, dots or hyphens, not an ISO date: a protocol, trial, phone or fax number
 * ("AB-1234-567-8901", "2024-500123-45", "+44 20 7946 0958"), or an account printed in groups. Only the words around it
 * tell which, so it goes in a string about a bank or a tax id and stays everywhere else.
 */
const GROUPED_RUN = /\b(?!\d{4}-\d{2}-\d{2}\b)\d(?:[ .-]?\d){7,}\b/g;
/** A US tax id as printed (EIN 12-3456789, SSN 123-45-6789): no protocol or phone number has these groups. */
const TAX_ID = /\b(?:\d{2}-\d{7}|\d{3}-\d{2}-\d{4})\b/g;
/** A phone or fax number however its digits run: "+" and a country code, or a phone word before it; at most 15 digits (E.164). */
const PHONE = /(?:\+|\b(?:tel(?:ephone)?|phone|fax|facsimile|mobile)\b\.?:?\s*)[(\d][\d\s().-]{6,}\d/gi;
/** A SWIFT/BIC code: 4 bank letters, 2 country letters, 2 location characters, optional 3-character branch. */
const BIC = /\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/;
const R = "[redacted]";
/** A payment card number however it's grouped: 13 to 19 digits passing the Luhn check. It goes anywhere, whatever words surround it. */
const card = (run: string) => {
  const d = run.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
};

/**
 * IBANs, tax ids, card numbers and unbroken runs go anywhere (but a phone number's digits, outside a string about a bank); grouped runs in a
 * string about a bank or a tax id; a string naming bank details that still carries an account or SWIFT code goes whole.
 */
export function scrub(s: string): string {
  const bank = bankOrTax(s);
  const phones = bank ? [] : [...s.matchAll(PHONE)].filter((m) => m[0].replace(/\D/g, "").length <= 15).map((m) => [m.index, m.index + m[0].length]);
  const t = s.replace(LONG_RUN, (run, at: number) => (phones.some(([a, b]) => at >= a! && at < b!) ? run : R)).replace(IBAN, R).replace(TAX_ID, R);
  const u = bank ? t.replace(GROUPED_RUN, R) : t.replace(GROUPED_RUN, (run, at: number) => (card(run) && !phones.some(([a, b]) => at >= a! && at < b!) ? R : run));
  return BANKISH.test(u) && (u.includes(R) || BIC.test(u)) ? R : u;
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
    // a model's provenance never carries a method (model-schema.ts sets "ai"): "text" is the code read's own (gridtext.ts)
    o.method = o.method === "text" ? "text" : "ai";
    o.crossCheck = "not_checked";
    const src = o.source as { documentId: string; quote?: string } | null;
    if (src && !ids.has(src.documentId)) {
      if (onlyId) src.documentId = onlyId;
      else o.source = null;
    }
    if (src?.quote && BANK_QUOTE.test(src.quote)) delete src.quote;
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
function imageTokensOf(png: Buffer): number {
  return Math.ceil((png.readUInt32BE(16) * png.readUInt32BE(20)) / 750);
}

/**
 * Rough USD estimate of the required reads (terms + grids, primary + terms cross-read) and per grid.
 * Output allowances are generous on purpose: the check refuses up front rather than overspend.
 */
function estimateUsd(clients: Clients, termImages: Image[], gridImages: Image[][]) {
  // a token map is text the model reads too: about 3 characters a token (digits and punctuation tokenize poorly)
  const imageTokens = (i: Image) => imageTokensOf(i.png) + (i.tokens?.length ? Math.ceil(tokenText(i.tokens).length / 3) : 0);
  const price = (c: LlmClient | null | undefined) => (c && c.provider === "anthropic" ? priceOf(c.model) : null);
  const p = price(clients.primary) ?? priceOf("claude-sonnet-5-5");
  const termsTok = termImages.reduce((n, i) => n + imageTokens(i), 0) + 3000;
  // one cache write + two cache reads, ~6K output tokens per terms call
  const terms = (pr: { in: number; out: number; cacheWrite: number; cacheRead: number }) => (termsTok * (pr.cacheWrite + 2 * pr.cacheRead) + 3 * 6000 * pr.out) / 1e6;
  const perGrid = gridImages.map((imgs) => ((imgs.reduce((n, i) => n + imageTokens(i), 0) + 2000) * p.in + 15000 * p.out) / 1e6);
  const cp = price(clients.cross);
  const cross = clients.cross ? (cp ? terms(cp) : terms({ in: 5, out: 30, cacheWrite: 5, cacheRead: 5 })) : 0;
  const required = terms(p) + perGrid.reduce((a, b) => a + b, 0) + cross;
  return { required, perGrid };
}
