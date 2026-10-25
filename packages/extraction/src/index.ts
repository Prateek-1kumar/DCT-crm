import { renderPng } from "./render";

export { identifyDocuments, extractStudy, ExtractionLimitError, type InputDoc, type ExtractionOutput } from "./extract";
export { runContractChecks, type CheckOptions, type ExtractionNote, type PageInfo } from "./checks";
export { pageCount, RENDER_LIMITS } from "./render";

/** PNG of one page (1-based), for the page viewer. Rejects bad page numbers; DPI and pixel size are capped (RENDER_LIMITS). */
export const renderPage = (pdfPath: string, page: number, dpi = 150): Promise<Buffer> => renderPng(pdfPath, page, { dpi });
