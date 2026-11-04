import type { Rulebook } from "@dct/shared";
import type { LoadedDoc, UnaccountedAmount } from "../types";
import { amountsIn } from "./text";

function knownAmounts(rulebook: Rulebook): Set<number> {
  const cents: number[] = [];
  const strings: (string | null)[] = [];
  const push = (v: unknown) => typeof v === "number" && cents.push(v);
  for (const t of rulebook.terms) {
    push(t.amountCents);
    if (t.cap?.kind === "amount") push(t.cap.value);
    strings.push(t.formula, t.conditions, t.notes, t.trigger, t.cap?.text ?? null, t.deadline, t.unit);
  }
  for (const g of rulebook.grids) {
    push(g.grandTotalCents);
    g.rows.forEach((r) => (push(r.unitCostCents), push(r.printedRowTotalCents), r.cells.forEach(push)));
    [g.subtotal, g.overhead, g.total, ...g.additions.map((a) => a.cells)].forEach((line) => line?.forEach(push));
  }
  rulebook.accounted.forEach((a) => push(a.amountCents));
  strings.forEach((s) => s && cents.push(...amountsIn(s)));
  // credits are written negative in the rulebook and printed in brackets, so compare magnitudes
  return new Set(cents.map(Math.abs));
}

// A coincidental match anywhere in the rulebook counts as accounted. Upgrade path: match by page and label.
export function unaccounted(rulebook: Rulebook, docs: LoadedDoc[]): UnaccountedAmount[] {
  const known = knownAmounts(rulebook);
  const noMoney = new Set(rulebook.study.documents.filter((d) => !d.hasMoney).map((d) => d.doc));
  const out: UnaccountedAmount[] = [];
  for (const doc of docs) {
    if (noMoney.has(doc.name)) continue;
    for (const page of doc.pages) {
      const skipped = rulebook.accounted.some((a) => a.doc === doc.name && a.pages?.includes(page.page));
      if (skipped) continue;
      const seen = new Set<number>();
      for (const line of page.layout.split("\n")) {
        for (const amount of amountsIn(line)) {
          if (amount === 0 || known.has(amount) || seen.has(amount)) continue;
          seen.add(amount);
          out.push({ doc: doc.name, page: page.page, amountCents: amount, context: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return out;
}
