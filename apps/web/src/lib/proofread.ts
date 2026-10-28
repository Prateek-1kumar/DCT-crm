import { settled, type PageBox, type ProofreadMark, type RulebookVersionDto } from "@dct/shared";
import { api, ApiError } from "./api";
import { isMoneyPath, labelFor } from "./format";
import { getAt } from "./pointer";

type Box = NonNullable<PageBox["box"]>;
type ProofCell = { path: string; label: string; value: unknown; box: Box | null };
export type ProofSection = "terms" | "totals" | "rows";
/** One thing to proofread: a budget-grid row, a row of visit totals, or a single fee or term. */
export type ProofUnit = { id: string; section: ProofSection; title: string; sub: string; doc: string; page: number; cells: ProofCell[]; money: number };

export const SECTION_LABEL: Record<ProofSection, string> = { terms: "Fees and terms", totals: "Visit totals", rows: "Budget grid rows" };

const VISIT_ROWS: Record<string, string> = {
  totalCents: "Visit totals",
  procedureSubtotalCents: "Procedure subtotals",
  overheadCents: "Overhead per visit",
  nonProcedureCents: "Staff and stipends per visit",
};

const isMoney = (path: string) => isMoneyPath(path) || path.includes("/cells/");

/**
 * Everything the PDF check confirmed, grouped for proofreading and ordered biggest money first: fees and terms (those
 * that aren't amounts, like holdback % or payment days, first: they apply to everything), then visit totals, then grid
 * rows by row total. A row printed across two pages is two units, one per page.
 */
export function proofUnits(v: Pick<RulebookVersionDto, "rulebook" | "evidence">): ProofUnit[] {
  const rb = v.rulebook;
  if (!rb) return [];
  const units = new Map<string, ProofUnit>();
  for (const e of v.evidence) {
    const w = e.where[0];
    if (e.status !== "confirmed" || !w) continue;
    const value = getAt(rb, e.path);
    const at = `${w.documentId}:${w.page}`;
    let key: string;
    let base: Omit<ProofUnit, "cells" | "money">;
    let label = "";
    let m: RegExpExecArray | null;
    if ((m = /^\/budgetGrids\/(\d+)\/procedures\/(\d+)\/(?:unitCents|cells\/([^/]+))$/.exec(e.path))) {
      const g = rb.budgetGrids[Number(m[1])]!;
      const p = g.procedures[Number(m[2])]!;
      key = `row:${m[1]}:${m[2]}:${at}`;
      base = { id: key, section: "rows", title: `${p.name}${p.code ? ` (${p.code})` : ""}`, sub: g.label, doc: w.documentId, page: w.page };
      label = m[3] ?? "Unit";
    } else if ((m = /^\/budgetGrids\/(\d+)\/visits\/(\d+)\/(\w+)$/.exec(e.path)) && VISIT_ROWS[m[3]!]) {
      const g = rb.budgetGrids[Number(m[1])]!;
      key = `tot:${m[1]}:${m[3]}:${at}`;
      base = { id: key, section: "totals", title: VISIT_ROWS[m[3]!]!, sub: g.label, doc: w.documentId, page: w.page };
      label = g.visits[Number(m[2])]!.code;
    } else {
      key = `val:${e.path}`;
      base = { id: key, section: e.path.startsWith("/budgetGrids/") ? "totals" : "terms", title: labelFor(e.path, rb), sub: "", doc: w.documentId, page: w.page };
    }
    const u = units.get(key) ?? { ...base, cells: [], money: 0 };
    u.cells.push({ path: e.path, label, value, box: w.box });
    if (typeof value === "number" && isMoney(e.path)) u.money += value;
    units.set(key, u);
  }
  const rank: Record<ProofSection, number> = { terms: 0, totals: 1, rows: 2 };
  const weight = (u: ProofUnit) => (u.section === "terms" && !isMoney(u.cells[0]!.path) ? Infinity : u.money);
  return [...units.values()].sort((a, b) => rank[a.section] - rank[b.section] || weight(b) - weight(a));
}

export type UnitStatus = "todo" | "done" | "reported";

/** Done once every value in it has a proofread mark; "reported" if any of its values was sent to Needs you. */
export function unitStatus(u: ProofUnit, marks: Map<string, ProofreadMark>, reported: Set<string>): UnitStatus {
  if (u.cells.some((c) => reported.has(c.path))) return "reported";
  return u.cells.every((c) => marks.has(c.path)) ? "done" : "todo";
}

/** Whether `v` has an open question about `path`. */
export const asked = (v: Pick<RulebookVersionDto, "review">, path: string) => v.review.some((i) => i.path === path && !settled(i));

/**
 * Sends each of `paths` to Needs you as looking wrong. On a live version the first report opens a correction draft and
 * the rest go there. `draft` holds where the reports got to and is updated after each one, so a try after a failure
 * carries on in that draft and skips what's already asked, instead of starting again on the live version (which
 * refuses once the draft exists). Resolves to the version the questions are on.
 */
export async function reportWrong(studyId: string, from: RulebookVersionDto, paths: string[], by: string, draft: { current: RulebookVersionDto | null }): Promise<number> {
  for (const path of paths) {
    const on = draft.current ?? from;
    if (on.status === "draft" && asked(on, path)) continue;
    try {
      draft.current = await api.reportValue(studyId, on.version, { path, note: "Looked wrong while proofreading", by });
    } catch (e) {
      // A report whose answer was lost can have gone through all the same: the draft then refuses it as already asked.
      if (!(e instanceof ApiError && e.status === 409 && on.status === "draft")) throw e;
      const now = await api.getVersion(studyId, on.version);
      if (!asked(now, path)) throw e;
      draft.current = now;
    }
  }
  return (draft.current ?? from).version;
}
