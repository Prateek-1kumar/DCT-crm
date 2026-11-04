import type { Question, Region, Rulebook } from "@dct/shared";

/** A word on a page, positioned as fractions 0–1 of the page, origin top-left. */
export interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * `text`: the page has a real text layer the checks can trust. `image`: a scan, or text drawn as vector outlines (very
 * few characters but many drawing operations), so only page images can be read (§5.1).
 */
export type PageKind = "text" | "image";

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
