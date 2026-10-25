import { renderPng } from "./render";

export { identifyDocuments, extractStudy, type InputDoc, type ExtractionOutput } from "./extract";
export { runContractChecks, type CheckOptions, type ExtractionNote, type PageInfo } from "./checks";
export { pageCount } from "./render";

/** PNG of one page (1-based), for the page viewer. */
export const renderPage = (pdfPath: string, page: number, dpi = 150): Promise<Buffer> => renderPng(pdfPath, page, { dpi });
