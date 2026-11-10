import type { Evidence, Region } from "@dct/shared";
import { useQuery } from "@tanstack/react-query";
import { formatCents } from "@/lib/money";
import { api, keys } from "@/lib/queries";
import type { CoverageRef } from "@/lib/types";
import { decidedBy, docName, findGrid, findTerm, pageAt, spotFor, STATUS, type ProofData } from "../../proof/model";
import { BILLING_LABEL, capText } from "../../rulebook";
import { gridProof } from "../../rulebook/model";
import { approxLabel, type ViewerBox } from "../../viewer";
import { amountsOf, visibleAmounts } from "../highlights";
import { termCard } from "../../overview/model";

export interface Head {
  name: string;
  value: string;
  evidence: Evidence;
  /** The page and file the line came from, for "Page 17 · Contract.pdf". */
  page: number;
  doc: string;
  quote: string | null;
  /** Label and words for the "Details" disclosure; only what the contract says. */
  details: [string, string][];
}

/** What the header says about a line, or null when the rulebook no longer has it. */
export function headOf(data: ProofData, line: CoverageRef): Head | null {
  const term = line.target === "term" ? findTerm(data, line.id) : undefined;
  if (term) {
    const conditions = [term.trigger, term.conditions].filter(Boolean).join(" · ");
    const details: [string, string][] = [
      ["Conditions", conditions],
      ["How it is paid", BILLING_LABEL[term.billing]],
      ["Cap", term.cap ? capText(term.cap) : ""],
      ["Deadline", term.deadline ?? ""],
      ["Notes", term.notes ?? ""],
    ];
    return { name: term.name, value: termCard(term, new Set()).value, evidence: term.evidence, page: term.source.page, doc: term.source.doc, quote: term.source.quote || null, details: details.filter(([, v]) => v) };
  }
  const grid = line.target === "grid" ? findGrid(data, line.id) : undefined;
  if (!grid || line.target !== "grid") return null;
  const row = grid.rows[line.row];
  const cell = row?.cells[line.col];
  const twice = grid.cellsReadTwice.some(([r, c]) => r === line.row && c === line.col);
  const evidence: Evidence = row && decidedBy(data, line) ? "person" : twice ? "two_reads" : gridProof(grid, data.version);
  const value = row ? (typeof cell === "number" ? formatCents(cell) : (cell ?? "blank")) : grid.grandTotalCents === null ? "The whole budget" : `${formatCents(grid.grandTotalCents)} per patient`;
  return {
    name: row ? `${row.name}, ${grid.visits[line.col] ?? "a visit"}` : grid.name,
    value,
    evidence,
    page: grid.pages[0] ?? 1,
    doc: grid.doc,
    quote: null,
    details: [["Budget", grid.arm ? `${grid.name} · ${grid.arm}` : grid.name]],
  };
}

const union = (boxes: Region[]): Region | null => (boxes.length ? [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))] : null);

/**
 * What the viewer is given for one line: which page, the box to zoom to, and the boxes to draw. The quote's own boxes come from
 * searching a text page, else the clause boxes the checker saved; a grid cell focuses its amount. Other amounts are drawn only
 * when they are problems, unless `showAll`.
 */
export function usePassage(data: ProofData, line: CoverageRef, moved: number | null, showAll: boolean) {
  const term = line.target === "term" ? findTerm(data, line.id) : undefined;
  const home = spotFor(data, line);
  const homePage = pageAt(data, home);
  const quote = term?.source.quote ?? "";
  const search = useQuery({
    queryKey: keys.find(home?.doc ?? "", home?.page ?? 0, quote),
    queryFn: () => api.find(home!.doc, home!.page, quote),
    enabled: !!home && homePage?.kind === "text" && quote !== "",
  });

  const page = moved ?? home?.page ?? 1;
  const here = !!home && page === home.page;
  const current = home ? pageAt(data, { doc: home.doc, page }) : undefined;
  const clauses = homePage?.clauses.filter((c) => c.termId === term?.id) ?? [];
  const found = !!search.data?.boxes.length;
  const quoted: Region[] = here ? (found ? search.data!.boxes : clauses.flatMap((c) => c.boxes)) : [];
  const quotedApprox = here && quoted.length > 0 && (found ? !!search.data!.approx : clauses.some((c) => c.approx));
  const strong = current && here ? amountsOf(current, line) : [];

  const amountName = (ref: CoverageRef | null) => ref && (ref.target === "term" ? findTerm(data, ref.id)?.name : findGrid(data, ref.id)?.name);
  const boxes: ViewerBox[] = quoted.map((box, i) => ({ id: `quote-${i}`, box, tone: "focus", label: approxLabel("The words quoted in the rulebook", quotedApprox), ...(quotedApprox && { approx: true }) }));
  for (const i of current ? visibleAmounts(current, { showAll, selected: null, strong }) : []) {
    const a = current!.amounts[i]!;
    const named = amountName(a.ref);
    boxes.push({
      id: `amount-${i}`,
      box: a.box,
      tone: strong.includes(i) ? "focus" : a.doubt ? "doubt" : a.status === "missing" ? "problem" : a.status,
      label: approxLabel(`${a.text} · ${STATUS[a.status].chip}${named ? ` as ${named}` : ""}${a.doubt ? ` · read with a doubt: ${a.doubt.replace("_", " ")}` : ""}`, a.approx, a.text),
      ...(a.approx && { approx: true }),
    });
  }
  const focus = union(quoted) ?? (strong[0] !== undefined ? current!.amounts[strong[0]]!.box : null);
  const focusApprox = boxes.some((b) => b.tone === "focus" && b.approx);

  return {
    docId: home?.doc ?? "",
    page,
    pageCount: home ? (data.version.documents.find((d) => d.id === home.doc)?.pageCount ?? 0) : 0,
    docName: home ? docName(data, home.doc) : "",
    home,
    focus: here ? focus : null,
    /** The passage being zoomed to is an approximate area, so the screen says so. */
    focusApprox: here && focusApprox,
    boxes,
    /** Still looking for the quote on its page: drawing the viewer now would zoom to the wrong place and then jump. */
    pending: here && search.isLoading,
    lost: here && !search.isLoading && quote !== "" && quoted.length === 0 && current?.kind !== "image",
  };
}
