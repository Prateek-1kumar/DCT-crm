import type { Anchor, besideOnLine, bindEvidence, gateSweep, lastSigned, NonFee, pageCount, PageInfo, PrintedRow, ReadWarning, readTextLayer, reviewFromEvidence, solveGrids } from "@dct/extraction";
import type { ContractAnomaly, DocumentKind, Rulebook, SourceRef } from "@dct/shared";
import { config } from "../config.js";

/** Mirrors the `@dct/extraction` interface (docs/PHASE-1.md, "`@dct/extraction`"; docs/phase-1/extraction.md). */
export type InputDoc = { id: string; filename: string; path: string; kind: DocumentKind | null };

type StudyGuess = { sponsor: string | null; protocol: string | null; siteName: string | null; investigator: string | null };

export type ExtractionOutput = {
  rulebook: Rulebook;
  crossRead: Rulebook | null;
  pages: { documentId: string; page: number; kind: PageInfo["kind"]; readable: boolean; printed?: number[] }[];
  cost: { provider: "anthropic" | "openai"; model: string; inputTokens: number; outputTokens: number; usd: number }[];
  /** Ambiguity / retroactive notes the rulebook schema can't hold, and a grid's totals for several patients; stored on the version and passed back to the checks. */
  notes?: ExtractionNote[];
  /** What made the reading weaker than usual (a skipped or failed re-read, a failed cross-read), by kind; worded in jobs.ts. */
  warnings?: ReadWarning[];
  /** What the grid read says each row prints as its quantity and its own total; `bindEvidence` checks it against the scan (ADR-002). Absent when no row gave one. */
  printedRows?: PrintedRow[];
  /** Where the grid read says each value was printed (a token of the page's text or OCR), and the amounts it called no fee: claims `bindEvidence` and the sweep check against the page (ADR-002 PR 3). */
  anchors?: Anchor[];
  nonFee?: NonFee[];
  /** How many budget grids were read by code from the PDF's own text, their arithmetic closed (ADR-003 P2). */
  gridsFromText?: number;
};

export type ExtractionNote = {
  kind: "ambiguous" | "retroactive_no_date" | "estimate";
  topic: string;
  path: string | null;
  source: SourceRef | null;
  /** kind "estimate": a printed total for several patients, taken out of the grid's per-patient totals (a notice). */
  estimate?: { cents: number; patients: number; perPatientCents: number };
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
  /** The words a page prints beside a spot on its row (a fee's frequency beside its amount), for the interpretations. */
  besideOnLine: typeof besideOnLine;
  bindEvidence: typeof bindEvidence;
  reviewFromEvidence: typeof reviewFromEvidence;
  /** ADR-002 PR 2: the document's own arithmetic as a referee (`confirmed_by_math`), and the zone gate on the leftover-money sweep. Pure, no AI. */
  solveGrids: typeof solveGrids;
  gateSweep: typeof gateSweep;
  /** The latest date of signature an e-signature record prints (pages the read excluded), suggested for a date tied to signing. No AI. */
  lastSigned: typeof lastSigned;
}

/** The parts of the port with no AI in them: fake mode uses the real ones. */
export type NoAi = "renderPage" | "pageCount" | "readTextLayer" | "besideOnLine" | "bindEvidence" | "reviewFromEvidence" | "solveGrids" | "gateSweep" | "lastSigned";

let cached: Promise<ExtractionPort> | undefined;

/** EXTRACTION_FAKE=1 → synthetic fixture; otherwise the real `@dct/extraction` package. */
export function getExtraction(): Promise<ExtractionPort> {
  cached ??= config.extractionFake ? loadFake() : loadReal();
  return cached;
}

/** Fake mode fakes only the AI: page images and the PDF's text come from the real PDF, so the viewer and the checks are real. */
async function loadFake(): Promise<ExtractionPort> {
  const [{ fakeExtraction }, { renderPage, pageCount, readTextLayer, besideOnLine, bindEvidence, reviewFromEvidence, solveGrids, gateSweep, lastSigned }] = await Promise.all([import("./fake.js"), import("@dct/extraction")]);
  return { ...fakeExtraction, renderPage, pageCount, readTextLayer, besideOnLine, bindEvidence, reviewFromEvidence, solveGrids, gateSweep, lastSigned };
}

async function loadReal(): Promise<ExtractionPort> {
  // Lazy so fake mode (tests) never loads mupdf or the AI SDKs.
  return (await import("@dct/extraction")) satisfies ExtractionPort;
}
