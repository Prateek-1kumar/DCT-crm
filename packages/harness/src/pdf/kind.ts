import type { PageKind } from "../types";

// Below this a page's content can't be in its text layer: a blank page, a scan, or text drawn as curves
// (APL_3007's DocuSign'd pages keep only a 55-character header). Counting drawn paths missed those pages.
const MIN_TEXT_CHARS = 200;

export const classify = (textChars: number): PageKind => (textChars < MIN_TEXT_CHARS ? "image" : "text");
