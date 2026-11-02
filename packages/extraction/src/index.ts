import { renderPng } from "./render";

export { identifyDocuments, extractStudy, ExtractionLimitError, type InputDoc, type ExtractionOutput, type NonFee, type ReadWarning } from "./extract";
export { runContractChecks, type CheckOptions, type ExtractionNote, type PageInfo } from "./checks";
// name matching, for the evaluation scripts that score a read against the answer keys
export { norm, sameName, sharesWord } from "./checks";
export { pageCount, RENDER_LIMITS, RenderTimeoutError } from "./render";
export { readTextLayer, type TextPage, type Span } from "./textlayer";
export { ocrPage, type OcrReading, type OcrWord } from "./ocr";
export { bindEvidence, reviewFromEvidence, type Anchor, type PrintedRow, type RowBand, type TableCheck } from "./binder";
export { gateSweep, type SweepCtx, type SweepReport } from "./sweep";

/** PNG of one page (1-based), for the page viewer. Rejects bad page numbers; DPI and pixel size are capped (RENDER_LIMITS). */
export const renderPage = (pdfPath: string, page: number, dpi = 150): Promise<Buffer> => renderPng(pdfPath, page, { dpi });
export { solveGrids, type SolverMode, type SolverOptions, type SolverReport, type IdentityKind } from "./solver";
export { readTextGrids, type TextGrid } from "./gridtext";
export { besideOnLine } from "./textlayer";
