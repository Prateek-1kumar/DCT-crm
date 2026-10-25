import type { ContractAnomaly, DocumentKind, Rulebook } from "@dct/shared";
import { config } from "../config.js";

/** Mirrors the `@dct/extraction` interface in docs/PHASE-1.md. */
export type InputDoc = { id: string; filename: string; path: string; kind: DocumentKind | null };

export type StudyGuess = { sponsor: string | null; protocol: string | null; siteName: string | null; investigator: string | null };

export type ExtractionOutput = {
  rulebook: Rulebook;
  crossRead: Rulebook | null;
  pages: { documentId: string; page: number; kind: "terms" | "budget_grid" | "invoiceables" | "signatures" | "boilerplate"; readable: boolean }[];
  cost: { provider: "anthropic" | "openai"; model: string; inputTokens: number; outputTokens: number; usd: number }[];
};

export interface ExtractionPort {
  identifyDocuments(docs: InputDoc[]): Promise<{ documentKinds: Record<string, DocumentKind>; studyGuess: StudyGuess }>;
  extractStudy(input: { documents: InputDoc[]; onProgress?: (pct: number, step: string) => void }): Promise<ExtractionOutput>;
  runContractChecks(rulebook: Rulebook, opts?: { crossRead?: Rulebook | null }): ContractAnomaly[];
  renderPage(pdfPath: string, page: number, dpi?: number): Promise<Buffer>;
}

let cached: Promise<ExtractionPort> | undefined;

/** EXTRACTION_FAKE=1 → synthetic fixture; otherwise the real `@dct/extraction` package. */
export function getExtraction(): Promise<ExtractionPort> {
  cached ??= config.extractionFake ? import("./fake.js").then((m) => m.fakeExtraction) : loadReal();
  return cached;
}

async function loadReal(): Promise<ExtractionPort> {
  // TODO(lead, at merge): add "@dct/extraction": "workspace:*" to apps/api/package.json and replace this
  // with a static `import * as extraction from "@dct/extraction"`. The variable specifier keeps the api
  // building and testing (fake mode) before Workstream B's package exists.
  const spec = "@dct/extraction";
  try {
    return (await import(/* @vite-ignore */ spec)) as ExtractionPort;
  } catch (err) {
    throw new Error(`@dct/extraction is not available (${(err as Error).message}). Set EXTRACTION_FAKE=1 to run without it.`);
  }
}
