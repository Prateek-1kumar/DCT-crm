import { type DocumentKind, Rulebook } from "@dct/shared";
// Imported, not read from disk next to this file: a bundle that inlines this package (the API's build) has no fixtures/ beside it.
import data from "../fixtures/fake-extraction.json" with { type: "json" };
import type { ExtractionNote, PageInfo } from "./checks";
import type { ExtractionOutput, InputDoc } from "./extract";

/** EXTRACTION_FAKE=1: a synthetic study (not a real contract) so the API and UI run without AI keys. */

const fixture = data as unknown as { rulebook: unknown; pages: PageInfo[]; notes: ExtractionNote[] };

/** Fixture uses doc-1 / doc-2; point them at the caller's documents. */
function remap<T>(v: T, docs: InputDoc[]): T {
  const map: Record<string, string> = { "doc-1": docs[0]!.id, "doc-2": (docs[1] ?? docs[0]!).id };
  return JSON.parse(JSON.stringify(v), (k, x) => ((k === "documentId" || k === "id") && typeof x === "string" && map[x] ? map[x] : x));
}

export async function fakeIdentify(docs: InputDoc[]) {
  const kinds: DocumentKind[] = ["work_order", "budget", "amendment"];
  return {
    documentKinds: Object.fromEntries(docs.map((d, i) => [d.id, d.kind ?? kinds[i] ?? "other"])) as Record<string, DocumentKind>,
    studyGuess: { sponsor: "Northwind Therapeutics, Inc.", protocol: "NWT-204", siteName: "Example Research Site, LLC", investigator: "Alex Rivera, MD" },
  };
}

export async function fakeExtract({ documents, onProgress }: { documents: InputDoc[]; onProgress?: (pct: number, step: string) => void }): Promise<ExtractionOutput> {
  if (!documents.length) throw new Error("There are no documents to read.");
  for (const [pct, step] of [
    [10, "Rendering pages (fake)"],
    [40, "Reading contract terms (fake)"],
    [80, "Reading budget grids (fake)"],
    [100, "Extraction complete (fake)"],
  ] as const)
    onProgress?.(pct, step);

  const rulebook = Rulebook.parse(remap(fixture.rulebook, documents));
  const fixtureDocs = rulebook.documents;
  rulebook.documents = documents.map((d, i) => ({ ...(fixtureDocs[i] ?? fixtureDocs[0]!), id: d.id, kind: d.kind ?? fixtureDocs[i]?.kind ?? "other" }));

  // The cross-read disagrees on one amount so AI_DISAGREEMENT shows up in the UI.
  const crossRead = structuredClone(rulebook);
  crossRead.invoiceables[0]!.amountWithOverheadCents = 54100;
  rulebook.invoiceables[0]!.prov.crossCheck = "disagree";

  const seen = new Set<string>();
  const pages = remap(fixture.pages, documents).filter((p) => !seen.has(`${p.documentId}:${p.page}`) && seen.add(`${p.documentId}:${p.page}`));
  return {
    rulebook,
    crossRead,
    pages,
    cost: [
      { provider: "anthropic", model: "fake", inputTokens: 0, outputTokens: 0, usd: 0 },
      { provider: "openai", model: "fake", inputTokens: 0, outputTokens: 0, usd: 0 },
    ],
    notes: remap(fixture.notes, documents),
    warnings: [{ kind: "fake", text: "EXTRACTION_FAKE=1: synthetic fixture, not read from the uploaded files" }],
  };
}
