import type { Question, Region, Rulebook } from "@dct/shared";
import type { ScanCell } from "./scan/cells";
import type { Transcription } from "./scan/transcribe";

/** A word on a page, positioned as fractions 0–1 of the page, origin top-left. */
export interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Set on a scanned word the reader wasn't sure of or saw marked up; absent on a real text layer. */
  doubt?: Doubt;
}

export type Doubt = "unsure" | "handwritten" | "struck_out" | "initialed";

/**
 * `text`: a real text layer, exact. `scan`: a scan (or text drawn as outlines) whose words were transcribed by the vision
 * model. `image`: a scan not transcribed yet, so it has no words (§5.1).
 */
export type PageKind = "text" | "scan" | "image";

export interface Page {
  page: number;
  kind: PageKind;
  /** Columns kept aligned like `pdftotext -layout`, so budget tables read as tables. */
  layout: string;
  raw: string;
  words: Word[];
  /** Bank-detail regions, painted over in every rendered image. */
  maskBoxes: Region[];
  firstLine: string;
  /**
   * Degrees clockwise a sideways or upside-down scan was turned to read; 0 otherwise. Words, masks and rendered images are
   * all in the turned (readable) frame.
   */
  rotation: number;
  /** A transcribed scan's cells and lines with their ids: what its amounts cite. */
  cells?: ScanCell[];
  /** What the cells come from, for comparing with a second read of the page. */
  transcription?: Transcription;
  /** Top and bottom of each scanned line and row where its words are shown, by its id ("p7.l2", "p7.t1.r5"); for display only. */
  bands?: Record<string, [number, number]>;
}

/** What the vision model transcribed from one page: kept per file, so each scan is paid for once. The words are derived on load, so a fix to `toWords` reaches pages already saved. */
export interface ScanPage {
  page: number;
  /** Names the transcription prompt and model, so a page read by another is read again. */
  version: string;
  /** Degrees clockwise the page was turned to read (a sideways or upside-down scan); the words are in the turned frame. */
  rotation: number;
  transcription: Transcription;
}

export interface ScanStore {
  get(sha256: string): Promise<ScanPage[]>;
  put(sha256: string, page: ScanPage): Promise<void>;
  /** Blind second reads of pages, kept apart so one never stands in for a page's transcription. */
  verify?: ScanStore;
}

export interface LoadedDoc {
  name: string;
  path: string;
  sha256: string;
  pages: Page[];
}

export interface PdfReader {
  load(path: string): Promise<LoadedDoc>;
  /** PNG of a page or a region of it, with the page's mask boxes painted over. dpi is capped at 300 and lowered if the image would exceed `maxPixels` (default ~2.5 megapixels). */
  render(doc: LoadedDoc, page: number, opts?: { region?: Region; dpi?: number; maxPixels?: number }): Promise<Buffer>;
}

export interface Problem {
  check: "grid" | "quote" | "cell" | "relation" | "unaccounted" | "schema";
  id?: string;
  doc?: string;
  page?: number;
  message: string;
}

export interface GridResult {
  problems: string[];
  /** Cells (row index, visit index) no captured printed identity covers: they need cell-level evidence (§5.3.2). */
  unproven: { row: number; col: number }[];
}

export interface UnaccountedAmount {
  doc: string;
  page: number;
  amountCents: number;
  context: string;
}

export interface CheckReport {
  grids: Record<string, GridResult>;
  quotes: Record<string, string>;
  unaccounted: UnaccountedAmount[];
  /** Decision questions the required-decision rules raise (§5.3.5), origin "rule". */
  required: Question[];
  problems: Problem[];
}

export interface Checks {
  checkGrid(grid: Rulebook["grids"][number], docs: LoadedDoc[]): GridResult;
  checkQuote(source: Rulebook["terms"][number]["source"], docs: LoadedDoc[]): string | null;
  unaccounted(rulebook: Rulebook, docs: LoadedDoc[]): UnaccountedAmount[];
  requiredDecisions(rulebook: Rulebook): Question[];
  runChecks(rulebook: Rulebook, docs: LoadedDoc[]): CheckReport;
}
