import type { Token } from "./llm";
import type { PageRect } from "./render";
import type { TextPage } from "./textlayer";

/**
 * The token map that goes to a model beside an image (ADR-002 §1.1; EXTRACTION_TOKEN_MAP): the words the text pass found in it,
 * each with an id and its box in that image's own pixels. This is contract text, so it leaves only through llm.ts, and never
 * into a log, an error or a warning. Bank details are not in it (ADR-001 §9: as text no more than as pixels).
 */

/** A piece of an image: the upright-pixel box `from` the page, drawn with its top left at `at` in the image. */
export type TokenSeg = { from: PageRect; at: [number, number] };

const overlaps = (a: PageRect, b: PageRect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * A token's id is its document's place in the read, its page and its place in the page's words, so it is the same in every
 * image that holds it (a header on every band, the overlap of two tiles). `to` carries the text layer's boxes into the upright
 * frame in points, `s` is pixels per point, `bank` the page's bank areas, `clean` says whether a text may go to a model.
 * A word is a token only when its centre is inside a seg (half open, so a cut between two lines gives each token one band).
 * Only a page of the PDF's own text or our OCR gives tokens: a scanner's own text layer is never trusted, and has no bank mask.
 */
export function tokensFor(p: TextPage, docIndex: number, to: (r: PageRect) => PageRect, s: number, bank: PageRect[], clean: (text: string) => boolean, segs: TokenSeg[]): Token[] {
  if (p.source !== "text" && p.source !== "ocr") return [];
  return p.words.flatMap((w, i): Token[] => {
    if (w.hidden || !w.text.trim() || bank.some((b) => overlaps(b, w.rect)) || !clean(w.text)) return [];
    const [x0, y0, x1, y1] = to(w.rect).map((v) => v * s) as PageRect;
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const seg = segs.find(({ from: f }) => cx >= f[0] && cx < f[2] && cy >= f[1] && cy < f[3]);
    if (!seg) return [];
    const [dx, dy] = [seg.at[0] - seg.from[0], seg.at[1] - seg.from[1]];
    return [{ id: `${docIndex}.${p.page}.${i}`, text: w.text, box: [Math.round(x0 + dx), Math.round(y0 + dy), Math.round(x1 + dx), Math.round(y1 + dy)] }];
  });
}

/** Cells of a grid read keep a token id only if it is in the map the model was given with that call; any other is dropped. */
export function dropUnknownTokens(grids: { procedures: { cells: { source_token_id?: string | undefined }[] }[]; visitTokens?: { source_token_id: string }[] | undefined }[], known: Set<string>): void {
  for (const g of grids) {
    for (const c of g.procedures.flatMap((p) => p.cells)) if (c.source_token_id !== undefined && !known.has(c.source_token_id)) delete c.source_token_id;
    if (g.visitTokens) g.visitTokens = g.visitTokens.filter((t) => known.has(t.source_token_id));
  }
}
