import { type DocumentKind, Rulebook } from "@dct/shared";
import { compareRulebooks, type ExtractionNote, type PageInfo, provAt } from "./checks";
import { fakeExtract, fakeIdentify } from "./fake";
import { clientsFromEnv, type CostEntry, type Image, type LlmClient } from "./llm";
import { type AiGrid, AiGrids, AiIdentify, AiPages, type AiTerms, AiTermsItems, AiTermsPayment, AiTermsStudy, classifyPrompt, gridPrompt, identifyPrompt, SYSTEM, termsPrompt } from "./prompts";
import { dpiToFit, pageCount, RENDER_LIMITS, renderPng, renderTiles, type Rotation, tileLayout } from "./render";

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

export type Clients = { primary: LlmClient; cross: LlmClient | null };

// Claude's vision input tops out at 2576 px long edge and ~3.75 MP; anything larger is downscaled
// server-side, which would throw away the high-DPI render. Keep every image under both.
export const CONFIG = {
  classifyMaxPx: 1000,
  identifyMaxPx: 1400,
  /** Letter page at 2150 px long edge ≈ 3.6 MP. */
  pageMaxPx: 2150,
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
  const { primary, cross } = clientsFromEnv();
  if (!primary) throw new Error("ANTHROPIC_API_KEY is not set. Set it in .env, or set EXTRACTION_FAKE=1 to use the synthetic fixture.");
  return { primary, cross };
}

const label = (documentId: string, page: number, extra = "") => `documentId ${documentId}, page ${page}${extra ? `, ${extra}` : ""}`;

async function pageImage(doc: InputDoc, page: number, maxPx: number, rotate: Rotation = 0, capDpi = CONFIG.pageMaxDpi): Promise<Image> {
  const dpi = await dpiToFit(doc.path, page, maxPx, capDpi);
  return { label: label(doc.id, page), png: await renderPng(doc.path, page, { dpi, rotate, gray: true }) };
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
  return identifyWith(docs, envClients().primary);
}

export async function identifyWith(docs: InputDoc[], llm: LlmClient) {
  const counts = (await countPages(docs)).map((n) => Math.min(3, n));
  budget(CONFIG.maxImagesPerExtraction, "page images").take(counts.reduce((a, b) => a + b, 0));
  const images: Image[] = [];
  for (const [i, d] of docs.entries()) for (let p = 1; p <= counts[i]!; p++) images.push(await pageImage(d, p, CONFIG.identifyMaxPx));
  const res = await llm.call({ name: "identify", system: SYSTEM, prompt: identifyPrompt(docs), images, schema: AiIdentify, effort: "low" });
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
  clients: Clients,
): Promise<ExtractionOutput> {
  const progress = (pct: number, step: string) => onProgress?.(Math.round(pct), step);
  const warnings: string[] = [];
  if (!documents.length) throw new Error("extractStudy: no documents");

  // 0. Caps first: nothing is rendered or sent until the page counts are within limits.
  const counts = await countPages(documents);
  const images = budget(CONFIG.maxImagesPerExtraction, "page images");
  const tiles = budget(CONFIG.maxTilesPerExtraction, "grid image tiles");
  images.take(counts.reduce((a, b) => a + b, 0));

  // 1. Classify every page (low-res, upright or not).
  progress(2, "Rendering pages");
  const pages: ClassifiedPage[] = (
    await pool(documents, CONFIG.concurrency, async (doc) => {
      const n = counts[documents.indexOf(doc)]!;
      const images = [];
      for (let p = 1; p <= n; p++) images.push(await pageImage(doc, p, CONFIG.classifyMaxPx));
      const res = await clients.primary.call({ name: "classify", system: SYSTEM, prompt: classifyPrompt(doc.id, doc.filename, n), images, schema: AiPages, effort: "low" });
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
  let termPages = readable.filter((p) => p.kind === "terms" || p.kind === "invoiceables");
  if (!termPages.length) termPages = readable.filter((p) => p.kind !== "budget_grid");
  images.take(termPages.length);
  const termImages = await Promise.all(termPages.map((p) => pageImage(docOf.get(p.documentId)!, p.page, CONFIG.pageMaxPx, p.rotation)));

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
      const opts = { dpi: CONFIG.gridDpi, rotate: p.rotation, maxPx: CONFIG.tileMaxPx, gray: true };
      const layout = await tileLayout(doc.path, p.page, opts);
      tiles.take(layout.count);
      images.take(layout.count + (layout.count > 1 ? 1 : 0));
      const pageTiles = await renderTiles(doc.path, p.page, { ...opts, maxTiles: layout.count });
      if (pageTiles.length > 1) imgs.push({ ...(await pageImage(doc, p.page, CONFIG.gridOverviewMaxPx, p.rotation)), label: label(doc.id, p.page, "overview") });
      for (const t of pageTiles) imgs.push({ label: label(doc.id, p.page, pageTiles.length > 1 ? `tile row ${t.row + 1}/${t.rows} column ${t.col + 1}/${t.cols}` : ""), png: t.png });
    }
    gridImages.push(imgs);
  }
  progress(25, `Reading ${termPages.length} term pages and ${groups.length} budget grid(s)`);

  // 3. Independent reads.
  const totalCalls = (1 + groups.length) * (clients.cross ? 2 : 1);
  let done = 0;
  const tick = (step: string) => progress(25 + (70 * ++done) / totalCalls, step);
  const read = async (llm: LlmClient) => {
    const who = llm.provider === "anthropic" ? "primary" : "cross-check";
    const termsP = Promise.all([
      llm.call({ name: "terms", system: SYSTEM, prompt: termsPrompt(documents, "study"), images: termImages, schema: AiTermsStudy, effort: "high" }),
      llm.call({ name: "terms-payment", system: SYSTEM, prompt: termsPrompt(documents, "payment"), images: termImages, schema: AiTermsPayment, effort: "high" }),
      llm.call({ name: "terms-items", system: SYSTEM, prompt: termsPrompt(documents, "items"), images: termImages, schema: AiTermsItems, effort: "high" }),
    ]).then(([study, payment, items]): AiTerms => (tick(`Read contract terms (${who})`), { ...study, ...payment, ...items }));
    const gridsP = pool(groups, CONFIG.concurrency, async (g) => {
      const i = groups.indexOf(g);
      const res = await llm.call({
        name: "grid",
        system: SYSTEM,
        prompt: gridPrompt(g[0]!.documentId, g.map((p) => p.page), gridImages[i]!.some((x) => x.label.includes("tile"))),
        images: gridImages[i]!,
        schema: AiGrids,
        effort: "high",
      });
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
  if (!clients.cross) warnings.push("Cross-read skipped: OPENAI_API_KEY or OPENAI_MODEL not set");

  // 4. Mark each primary value agree/disagree with the second read.
  if (cross) markCrossCheck(primary.rulebook, cross.rulebook);
  progress(100, "Extraction complete");

  return {
    rulebook: primary.rulebook,
    crossRead: cross?.rulebook ?? null,
    pages: pages.map(({ documentId, page, kind, readable }) => ({ documentId, page, kind, readable })),
    cost: [clients.primary.cost(), ...(clients.cross ? [clients.cross.cost()] : [])],
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

const BANKISH = /\b(routing|aba|swift|iban|account\s*(no|number|#)|acct|bank)\b/i;

/**
 * Normalise provenance (method/crossCheck, unknown document ids) and scrub anything bank-like
 * the model may have copied despite instructions: long digit runs, and quotes mentioning bank details.
 */
function sanitize(v: unknown, ids: Set<string>, onlyId: string | null): void {
  if (Array.isArray(v)) return v.forEach((x) => sanitize(x, ids, onlyId));
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) {
    if (typeof x === "string" && k !== "id" && k !== "documentId") o[k] = x.replace(/\b\d{8,17}\b/g, "[redacted]");
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
