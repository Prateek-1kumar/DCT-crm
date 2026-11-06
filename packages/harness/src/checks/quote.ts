import type { Rulebook } from "@dct/shared";
import type { LoadedDoc } from "../types";
import { normalise, looseContains } from "./text";

const squash = (s: string) => s.replace(/\s+/g, "");

export function checkQuote(source: Rulebook["terms"][number]["source"], docs: LoadedDoc[]): string | null {
  const doc = docs.find((d) => d.name === source.doc);
  if (!doc) return `document ${source.doc} not found`;
  const page = doc.pages.find((p) => p.page === source.page);
  if (!page) return `p.${source.page} does not exist in ${source.doc}`;
  const quote = normalise(source.quote);
  if (!quote) return `no quote given for p.${source.page} of ${source.doc}`;
  // a scan not yet transcribed has nothing to check against; runChecks asks for proof of its amounts instead
  if (page.kind === "image") return null;
  const found =
    page.kind === "scan"
      ? [page.raw, page.layout].some((t) => looseContains(t, source.quote))
      : [page.raw, page.layout].map(normalise).some((t) => t.includes(quote) || squash(t).includes(squash(quote)));
  return found ? null : `quote not found on p.${source.page} of ${source.doc}`;
}
