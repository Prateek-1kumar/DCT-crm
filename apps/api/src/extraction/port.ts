import type { bindEvidence, isoDate, readTextLayer, reviewFromEvidence } from "@dct/extraction";
import type { ContractAnomaly, DocumentKind, Rulebook, SourceRef } from "@dct/shared";
import { config } from "../config.js";

/** Mirrors the `@dct/extraction` interface in docs/PHASE-1.md. */
export type InputDoc = { id: string; filename: string; path: string; kind: DocumentKind | null };

export type StudyGuess = { sponsor: string | null; protocol: string | null; siteName: string | null; investigator: string | null };

export type ExtractionOutput = {
  rulebook: Rulebook;
  crossRead: Rulebook | null;
  pages: { documentId: string; page: number; kind: "terms" | "budget_grid" | "invoiceables" | "signatures" | "boilerplate"; readable: boolean; printed?: number[] }[];
  cost: { provider: "anthropic" | "openai"; model: string; inputTokens: number; outputTokens: number; usd: number }[];
  /** Ambiguity / retroactive notes the rulebook schema can't hold; stored on the version and passed back to the checks. */
  notes?: ExtractionNote[];
};

export type ExtractionNote = {
  kind: "ambiguous" | "retroactive_no_date";
  topic: string;
  path: string | null;
  source: SourceRef | null;
};

export type CheckOptions = { crossRead?: Rulebook | null; pages?: ExtractionOutput["pages"]; notes?: ExtractionNote[] };

export interface ExtractionPort {
  identifyDocuments(docs: InputDoc[]): Promise<{ documentKinds: Record<string, DocumentKind>; studyGuess: StudyGuess }>;
  extractStudy(input: { documents: InputDoc[]; onProgress?: (pct: number, step: string) => void }): Promise<ExtractionOutput>;
  runContractChecks(rulebook: Rulebook, opts?: CheckOptions): ContractAnomaly[];
  renderPage(pdfPath: string, page: number, dpi?: number): Promise<Buffer>;
  /** The evidence pipeline (ADR-001): the PDF's own text, each value bound to its spot, the questions for a person. No AI. */
  readTextLayer: typeof readTextLayer;
  bindEvidence: typeof bindEvidence;
  reviewFromEvidence: typeof reviewFromEvidence;
  /** The ISO date a printed text says, as the binder reads it ("Aug. 22nd, 2025" → "2025-08-22"). */
  isoDate: typeof isoDate;
}

/** The parts of the port with no AI in them: fake mode uses the real ones. */
export type NoAi = "renderPage" | "readTextLayer" | "bindEvidence" | "reviewFromEvidence" | "isoDate";

let cached: Promise<ExtractionPort> | undefined;

/** EXTRACTION_FAKE=1 → synthetic fixture; otherwise the real `@dct/extraction` package. */
export function getExtraction(): Promise<ExtractionPort> {
  cached ??= config.extractionFake ? loadFake() : loadReal();
  return cached;
}

/** Fake mode fakes only the AI: page images and the PDF's text come from the real PDF, so the viewer and the checks are real. */
async function loadFake(): Promise<ExtractionPort> {
  const [{ fakeExtraction }, { renderPage, readTextLayer, bindEvidence, reviewFromEvidence, isoDate }] = await Promise.all([import("./fake.js"), import("@dct/extraction")]);
  return { ...fakeExtraction, renderPage, readTextLayer, bindEvidence, reviewFromEvidence, isoDate };
}

async function loadReal(): Promise<ExtractionPort> {
  // Lazy so fake mode (tests) never loads mupdf or the AI SDKs.
  return (await import("@dct/extraction")) satisfies ExtractionPort;
}
