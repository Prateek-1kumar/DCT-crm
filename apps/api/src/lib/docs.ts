import { pdfReader, scanVersion, withScans, type LoadedDoc, type Reader } from "@dct/harness";
import { inArray } from "drizzle-orm";
import type { Tx } from "../db/index.js";
import { documents, type PageInfo } from "../db/schema.js";
import { pdfPath, scanStore } from "./storage.js";

const CACHED = 6;
// Loading parses every page; a document's content never changes, so its parse is kept by hash, least recently used out.
const cache = new Map<string, Promise<{ raw: LoadedDoc; shown: LoadedDoc }>>();

export const forgetStored = (sha256: string) => cache.delete(sha256);

function loadBoth(sha256: string) {
  let entry = cache.get(sha256);
  if (entry) cache.delete(sha256);
  else {
    entry = pdfReader.load(pdfPath(sha256)).then(async (raw) => ({ raw, shown: withScans(raw, await scanStore.get(sha256)) }));
    entry.catch(() => cache.delete(sha256));
  }
  cache.set(sha256, entry);
  if (cache.size > CACHED) cache.delete(cache.keys().next().value!);
  return entry;
}

/** The document as shown: every transcribed page, whichever model made it. */
export const loadStored = async (sha256: string) => (await loadBoth(sha256)).shown;

/**
 * The stored PDFs, loaded for the harness under their uploaded names (the rulebook cites documents by name). Given the
 * reader a read will use, only the pages it transcribed count: pages from another model or prompt are read again.
 */
export async function loadDocs(tx: Tx, ids: string[], reader?: Reader): Promise<LoadedDoc[]> {
  const rows = await tx.select().from(documents).where(inArray(documents.id, ids));
  return Promise.all(
    rows.map(async (row) => {
      if (!reader) return { ...(await loadStored(row.sha256)), name: row.name };
      const { raw } = await loadBoth(row.sha256);
      const current = (await scanStore.get(row.sha256)).filter((p) => p.version === scanVersion(reader));
      return { ...withScans(raw, current), name: row.name };
    }),
  );
}

export const pageInfos = (doc: LoadedDoc): PageInfo[] =>
  doc.pages.map((p) => ({ page: p.page, kind: p.kind, chars: p.words.reduce((n, w) => n + w.text.length, 0), firstLine: p.firstLine }));
