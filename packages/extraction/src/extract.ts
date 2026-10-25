import { type DocumentKind, Rulebook } from "@dct/shared";
import { compareRulebooks, type ExtractionNote, type PageInfo, provAt } from "./checks";
import { fakeExtract, fakeIdentify } from "./fake";
import { clientsFromEnv, type CostEntry, type Image, type LlmClient } from "./llm";
import { type AiGrid, AiGrids, AiIdentify, AiPages, type AiTerms, AiTerms as AiTermsSchema, classifyPrompt, gridPrompt, identifyPrompt, SYSTEM, termsPrompt } from "./prompts";
import { dpiToFit, pageCount, RENDER_LIMITS, renderPng, renderTiles, type Rotation } from "./render";

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

export const CONFIG = {
  classifyMaxPx: 1000,
  identifyMaxPx: 1400,
  pageMaxPx: 2400,
  pageMaxDpi: 300,
  gridOverviewMaxPx: 1600,
  /** Grid pages are re-rendered at this DPI and tiled (dense, sideways tables need 400+). */
  gridDpi: Number(process.env.EXTRACTION_GRID_DPI) || 400,
  tileMaxPx: 2400,
  concurrency: 3,
  /** Cost/resource caps: exceeding one fails the extraction with a clear error instead of running up AI cost. */
  maxPagesPerDoc: 100,
  maxTilesPerExtraction: 60,
  /** DPI clamp, pixel budget and tiles-per-page (shared with renderPage). */
  render: RENDER_LIMITS,
};

export class ExtractionLimitError extends Error {}

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
  const images: Image[] = [];
  for (const d of docs) {
    const n = Math.min(3, await pageCount(d.path));
    for (let p = 1; p <= n; p++) images.push(await pageImage(d, p, CONFIG.identifyMaxPx));
  }
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

  // 1. Classify every page (low-res, upright or not).
  progress(2, "Rendering pages");
  const pages: ClassifiedPage[] = (
    await pool(documents, CONFIG.concurrency, async (doc) => {
      const n = await pageCount(doc.path);
      if (n > CONFIG.maxPagesPerDoc) throw new ExtractionLimitError(`${doc.filename} has ${n} pages; the limit is ${CONFIG.maxPagesPerDoc} per document`);
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
  const termImages = await Promise.all(termPages.map((p) => pageImage(docOf.get(p.documentId)!, p.page, CONFIG.pageMaxPx, p.rotation)));

  const groups: ClassifiedPage[][] = [];
  for (const p of readable.filter((x) => x.kind === "budget_grid")) {
    const last = groups.at(-1)?.at(-1);
    const continues = last && last.documentId === p.documentId && last.page === p.page - 1 && last.gridGroup !== null && last.gridGroup === p.gridGroup;
    if (continues) groups.at(-1)!.push(p);
    else groups.push([p]);
  }
  // Rendered one group at a time so the tile cap trips before memory or AI cost run away.
  const gridImages: Image[][] = [];
  let tileCount = 0;
  for (const g of groups) {
    const imgs: Image[] = [];
    for (const p of g) {
      const doc = docOf.get(p.documentId)!;
      const tiles = await renderTiles(doc.path, p.page, { dpi: CONFIG.gridDpi, rotate: p.rotation, maxPx: CONFIG.tileMaxPx, gray: true });
      tileCount += tiles.length;
      if (tileCount > CONFIG.maxTilesPerExtraction)
        throw new ExtractionLimitError(`Budget grids need more than ${CONFIG.maxTilesPerExtraction} image tiles (limit per extraction); split the upload or raise CONFIG.maxTilesPerExtraction`);
      if (tiles.length > 1) imgs.push({ ...(await pageImage(doc, p.page, CONFIG.gridOverviewMaxPx, p.rotation)), label: label(doc.id, p.page, "overview") });
      for (const t of tiles) imgs.push({ label: label(doc.id, p.page, tiles.length > 1 ? `tile row ${t.row + 1}/${t.rows} column ${t.col + 1}/${t.cols}` : ""), png: t.png });
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
    const termsP = llm
      .call({ name: "terms", system: SYSTEM, prompt: termsPrompt(documents), images: termImages, schema: AiTermsSchema, effort: "high" })
      .then((t) => (tick(`Read contract terms (${who})`), t));
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
