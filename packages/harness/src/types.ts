import type { Question, Region, Rulebook } from "@dct/shared";

/** A word on a page, positioned as fractions 0–1 of the page, origin top-left. */
export interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** OCR's confidence in this word, 0–100; absent for words from a real text layer. */
  confidence?: number;
}

/**
 * `text`: a real text layer, exact. `ocr`: a scan (or text drawn as outlines) whose words came from OCR on this machine:
 * positions are reliable, characters may be misread. `image`: a scan not OCR'd yet, so it has no words (§5.1).
 */
export type PageKind = "text" | "ocr" | "image";

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
  /** Mean OCR word confidence, 0–100, for an `ocr` page; null otherwise. */
  confidence: number | null;
  /**
   * Degrees clockwise a sideways or upside-down scan was turned to read; 0 otherwise. Words, masks and rendered images are
   * all in the turned (readable) frame.
   */
  rotation: number;
}

/** What OCR found on one page: kept per file, so each scan is OCR'd once. */
export interface OcrPage {
  page: number;
  words: Word[];
  confidence: number;
  /** Degrees clockwise the page was turned to read (a sideways or upside-down scan); `words` are in the turned frame. */
  rotation: number;
}

export interface LoadedDoc {
  name: string;
  path: string;
  sha256: string;
  pages: Page[];
}

export interface PdfReader {
  load(path: string): Promise<LoadedDoc>;
  /** PNG of a page or a region of it, with the page's mask boxes painted over. dpi is capped at 300 and lowered if the image would exceed ~2.5 megapixels. */
  render(doc: LoadedDoc, page: number, opts?: { region?: Region; dpi?: number }): Promise<Buffer>;
}

export interface Problem {
  check: "grid" | "quote" | "unaccounted" | "schema";
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
