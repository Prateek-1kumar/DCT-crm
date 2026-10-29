import type { bindEvidence, pageCount, ReadWarning, readTextLayer, reviewFromEvidence } from "@dct/extraction";
import type { ContractAnomaly, DocumentKind, Rulebook, SourceRef } from "@dct/shared";
import { config } from "../config.js";

/** Mirrors the `@dct/extraction` interface (docs/PHASE-1.md, "`@dct/extraction`"; docs/phase-1/extraction.md). */
export type InputDoc = { id: string; filename: string; path: string; kind: DocumentKind | null };

type StudyGuess = { sponsor: string | null; protocol: string | null; siteName: string | null; investigator: string | null };

export type ExtractionOutput = {
  rulebook: Rulebook;
  crossRead: Rulebook | null;
  pages: { documentId: string; page: number; kind: "terms" | "budget_grid" | "invoiceables" | "signatures" | "boilerplate"; readable: boolean; printed?: number[] }[];
  cost: { provider: "anthropic" | "openai"; model: string; inputTokens: number; outputTokens: number; usd: number }[];
  /** Ambiguity / retroactive notes the rulebook schema can't hold; stored on the version and passed back to the checks. */
  notes?: ExtractionNote[];
  /** What made the reading weaker than usual (a skipped or failed re-read, a failed cross-read), by kind; worded in jobs.ts. */
  warnings?: ReadWarning[];
};

export type ExtractionNote = {
  kind: "ambiguous" | "retroactive_no_date";
  topic: string;
  path: string | null;
  source: SourceRef | null;
};

type CheckOptions = { crossRead?: Rulebook | null; pages?: ExtractionOutput["pages"]; notes?: ExtractionNote[] };

export interface ExtractionPort {
  identifyDocuments(docs: InputDoc[]): Promise<{ documentKinds: Record<string, DocumentKind>; studyGuess: StudyGuess }>;
  /** `signal`: the job's; once pg-boss gives up on the job, the read starts no further AI call. */
  extractStudy(input: { documents: InputDoc[]; onProgress?: (pct: number, step: string) => void; signal?: AbortSignal }): Promise<ExtractionOutput>;
  runContractChecks(rulebook: Rulebook, opts?: CheckOptions): ContractAnomaly[];
  renderPage(pdfPath: string, page: number, dpi?: number): Promise<Buffer>;
  /** Pages as the read counts them, in the PDF reader's worker (a crafted file costs a timeout, never the event loop). */
  pageCount: typeof pageCount;
  /** The evidence pipeline (ADR-001): the PDF's own text, each value bound to its spot, the questions for a person. No AI. */
  readTextLayer: typeof readTextLayer;
  bindEvidence: typeof bindEvidence;
  reviewFromEvidence: typeof reviewFromEvidence;
}

/** The parts of the port with no AI in them: fake mode uses the real ones. */
export type NoAi = "renderPage" | "pageCount" | "readTextLayer" | "bindEvidence" | "reviewFromEvidence";

let cached: Promise<ExtractionPort> | undefined;

/** EXTRACTION_FAKE=1 → synthetic fixture; otherwise the real `@dct/extraction` package. */
export function getExtraction(): Promise<ExtractionPort> {
  cached ??= config.extractionFake ? loadFake() : loadReal();
  return cached;
}

/** Fake mode fakes only the AI: page images and the PDF's text come from the real PDF, so the viewer and the checks are real. */
async function loadFake(): Promise<ExtractionPort> {
  const [{ fakeExtraction }, { renderPage, pageCount, readTextLayer, bindEvidence, reviewFromEvidence }] = await Promise.all([import("./fake.js"), import("@dct/extraction")]);
  return { ...fakeExtraction, renderPage, pageCount, readTextLayer, bindEvidence, reviewFromEvidence };
}

async function loadReal(): Promise<ExtractionPort> {
  // Lazy so fake mode (tests) never loads mupdf or the AI SDKs.
  return (await import("@dct/extraction")) satisfies ExtractionPort;
}
