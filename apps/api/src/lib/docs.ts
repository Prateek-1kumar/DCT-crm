import { pdfReader, withOcr, type LoadedDoc } from "@dct/harness";
import { inArray } from "drizzle-orm";
import type { Tx } from "../db/index.js";
import { documents, type PageInfo } from "../db/schema.js";
import { pdfPath, readOcr } from "./storage.js";

const CACHED = 6;
// Loading parses every page; a document's content never changes, so its parse is kept by hash, least recently used out.
const cache = new Map<string, Promise<LoadedDoc>>();

export const forgetStored = (sha256: string) => cache.delete(sha256);

export function loadStored(sha256: string): Promise<LoadedDoc> {
  let doc = cache.get(sha256);
  if (doc) cache.delete(sha256);
  else {
    doc = pdfReader.load(pdfPath(sha256)).then(async (loaded) => {
      const ocr = await readOcr(sha256);
      return ocr ? withOcr(loaded, ocr) : loaded;
    });
    doc.catch(() => cache.delete(sha256));
  }
  cache.set(sha256, doc);
  if (cache.size > CACHED) cache.delete(cache.keys().next().value!);
  return doc;
}

/** The stored PDFs, loaded for the harness under their uploaded names (the rulebook cites documents by name). */
export async function loadDocs(tx: Tx, ids: string[]): Promise<LoadedDoc[]> {
  const rows = await tx.select().from(documents).where(inArray(documents.id, ids));
  return Promise.all(rows.map(async (row) => ({ ...(await loadStored(row.sha256)), name: row.name })));
}

export const pageInfos = (doc: LoadedDoc): PageInfo[] =>
  doc.pages.map((p) => ({ page: p.page, kind: p.kind, chars: p.words.reduce((n, w) => n + w.text.length, 0), firstLine: p.firstLine, confidence: p.confidence }));
