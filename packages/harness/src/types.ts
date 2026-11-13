import type { Question, Region, Rulebook } from "@dct/shared";
import type { ScanCell } from "./scan/cells";
import type { LocateStore } from "./scan/detect";
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
  /** The page's blind second read, once one was made: an amount only it found may be one the first read dropped. */
  second?: Transcription;
  /** Top and bottom of each scanned line and row where its words are shown, by its id ("p7.l2", "p7.t1.r5"); for display only. */
  bands?: Record<string, [number, number]>;
  /** Where the scan's lines, rows and words really sit (§5.1); absent until the page has been through the locator, and then every mark on it is approximate. */
  located?: Located;
  /** The same for the page's second read, from the same OCR words. */
  locatedSecond?: Located;
}

/**
 * Real positions on a scanned page, as fractions of the page in the turned frame. They sit beside the made-up word
 * positions and change nothing that reading, masking or the checks depend on.
 */
export interface Located {
  /** The real box of each line or row found, its true vertical extent across the full page width, by id ("p7.l2", "p7.t1.r5", "p7.t1.h"). */
  rows: Record<string, Region>;
  /** For each line or row not found: the band between the nearest found ones above and below it, which holds it if the page is read in order. */
  bands: Record<string, Region>;
  /** The real box of each whitespace-separated word of a cell or line, by its id; null where the word wasn't found for certain. */
  words: Record<string, (Region | null)[]>;
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
  /** Where OCR found the words of each scanned page, so the page is detected once; without it every mark on a scan is approximate. */
  locate?: LocateStore;
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
  check: "grid" | "quote" | "cell" | "relation" | "unaccounted" | "amount" | "fee_table" | "schema";
  id?: string;
  doc?: string;
  page?: number;
  message: string;
  /** Settled after the compile (a second read, or a person), so it isn't the compile agent's to fix. */
  afterCompile?: true;
}

export interface GridResult {
  problems: string[];
  /** Cells (row index, visit index) no captured printed identity covers: they need cell-level evidence (§5.3.2). */
  unproven: { row: number; col: number }[];
  /** Unproven cells of a scan that a printed total or a sum relation does add up: a second read's figure may stand there. */
  bySumOnly?: { row: number; col: number }[];
}

export interface UnaccountedAmount {
  doc: string;
  page: number;
  amountCents: number;
  context: string;
  /** Only the page's second read found it. */
  secondRead?: true;
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
