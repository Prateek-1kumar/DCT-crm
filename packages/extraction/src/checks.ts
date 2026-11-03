import { type BudgetGrid, type ContractAnomaly, type ContractAnomalyCode, gridPrices, parseCents, type Provenance, type Rulebook, type SourceRef } from "@dct/shared";
import type { PageKind } from "./prompts";

/** Pure, deterministic contract checks. No AI. */

export type PageInfo = {
  documentId: string;
  page: number;
  /** Stored pages from before the three exclusion kinds hold only the first five; every consumer still accepts them. */
  kind: PageKind;
  readable: boolean;
  /** Money amounts (cents) printed in the page's embedded text; absent when the page has no text layer (a scan). */
  printed?: number[];
};

/**
 * Things the AI noticed that the Rulebook schema has no field for yet (see docs/phase-1/extraction.md,
 * "Proposed shared-schema changes"). Carried on ExtractionOutput.notes.
 */
export type ExtractionNote = {
  /** `estimate`: never the model's; a total for several patients the read took out of a grid's per-patient totals (splitEstimates). */
  kind: "ambiguous" | "retroactive_no_date" | "estimate";
  topic: string;
  /** JSON pointer of the affected rulebook value, if any (an estimate: its grid). */
  path: string | null;
  source: SourceRef | null;
  estimate?: Estimate;
};

/** A printed total for several patients: `patients` × `perPatientCents` = `cents`, to the cent. */
type Estimate = { cents: number; patients: number; perPatientCents: number };

/**
 * The patient counts a text states: "50 patients", "(50) subjects", "50-patient", "100 enrolled participants", "N = 50".
 * A number that is money ("$50 per patient"), a rate ("50 per patient") or before a compound ("50 patient-reported") states none.
 */
const PATIENTS =
  /(?<![\w$€£.,])(\d{1,3}(?:,\d{3})+|\d+)\)?[\s-]*(?:(?:evaluable|enrolled|randomi[sz]ed|completed|treated|screened|total|planned|expected|estimated|additional)\s+)?(?:patients?|subjects?|participants?|pts)\b(?!-)|\bn\s*=\s*(\d{1,3}(?:,\d{3})+|\d+)(?![\d.,]*\d)/gi;
export const patientCounts = (text: string): Set<number> => new Set([...text.matchAll(PATIENTS)].map((m) => Number((m[1] ?? m[2])!.replace(/,/g, ""))));

/**
 * The patients `cents` is the total for: exactly k times one of `bases` (integer cents, k ≥ 2), where `counts` (what the
 * text beside it states) holds k. An estimate that adds, rounds or leaves out anything doesn't match, and stays what it was.
 */
export function patientsTimes(cents: number, bases: readonly number[], counts: ReadonlySet<number>): { patients: number; perPatientCents: number } | null {
  for (const b of bases) if (b > 0 && cents % b === 0 && cents / b >= 2 && counts.has(cents / b)) return { patients: cents / b, perPatientCents: b };
  return null;
}

/**
 * A grid's printed totals for several patients ("estimated total, 50 patients"): its label states the count, and its amount
 * is exactly that many times the sum of every visit or another of the grid's per-patient totals. Never a per-patient total:
 * it isn't billed, and checking it against the visits only raises a false mismatch. Anything less sure stays a per-patient
 * total, checked and asked as one.
 */
export function multiPatientTotals(g: BudgetGrid): (Estimate & { index: number })[] {
  const visits = sum(g.visits.map((v) => v.totalCents));
  return g.perPatientTotals.flatMap((t, index) => {
    const m = patientsTimes(t.cents, [visits, ...g.perPatientTotals.filter((_, i) => i !== index).map((o) => o.cents)], patientCounts(t.label));
    return m ? [{ index, cents: t.cents, ...m }] : [];
  });
}

/** The read with each grid's multi-patient totals taken out of perPatientTotals, each kept as an `estimate` note (a notice). */
export function splitEstimates(rb: Rulebook): { rulebook: Rulebook; notes: ExtractionNote[] } {
  const notes: ExtractionNote[] = [];
  const budgetGrids = rb.budgetGrids.map((g, gi) => {
    const found = multiPatientTotals(g);
    for (const { index, ...estimate } of found) notes.push({ kind: "estimate", topic: g.perPatientTotals[index]!.label, path: `/budgetGrids/${gi}`, source: g.perPatientTotals[index]!.prov.source, estimate });
    return found.length ? { ...g, perPatientTotals: g.perPatientTotals.filter((_, i) => !found.some((e) => e.index === i)) } : g;
  });
  return { rulebook: { ...rb, budgetGrids }, notes };
}

export type CheckOptions = {
  crossRead?: Rulebook | null;
  /** ExtractionOutput.pages: enables UNREADABLE_PAGE and, for digital PDFs, TEXT_LAYER_MISMATCH. */
  pages?: PageInfo[];
  /** ExtractionOutput.notes: enables note-based AMBIGUOUS_TERM / RETROACTIVE_NO_DATE. */
  notes?: ExtractionNote[];
};

const LOW_CONFIDENCE = 0.8;
/** The kinds of document an amendment amends. */
const PARENT_KINDS: ReadonlySet<string> = new Set(["master_agreement", "work_order", "adoption"]);

const SEVERITY: Record<ContractAnomalyCode, ContractAnomaly["severity"]> = {
  GRID_CONFLICT: "blocker",
  HEADER_MISMATCH: "blocker",
  RETROACTIVE_NO_DATE: "blocker",
  UNREADABLE_PAGE: "blocker",
  TEXT_LAYER_MISMATCH: "warning",
  REQUIRED_MISSING: "warning",
  VISIT_TOTAL_MISMATCH: "warning",
  PER_PATIENT_TOTAL_MISMATCH: "warning",
  OVERHEAD_LABEL_MISMATCH: "warning",
  DUPLICATE_ITEM: "warning",
  MISSING_REFERENCED_DOC: "warning",
  AI_DISAGREEMENT: "warning",
  AMBIGUOUS_TERM: "warning",
  LOW_CONFIDENCE: "info",
  MULTI_PATIENT_ESTIMATE: "info",
};

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const refsOf = (...provs: (Provenance | null | undefined)[]) =>
  provs.flatMap((p) => (p?.source ? [p.source] : [])).filter((r, i, a) => a.findIndex((x) => x.documentId === r.documentId && x.page === r.page) === i);

/**
 * Allowed difference in cents: ±$1 only where the contract says it rounds to whole dollars (the read's "printed amounts"
 * with the words it read it from); a read that says so with no quote, or a contract silent on rounding, is billed to the
 * cent (the owner, 2026-11-02): ±1 cent of float noise.
 */
export const tolerance = (rb: Rulebook) => (rb.rounding.value === "printed_amounts" && rb.rounding.prov.source?.quote?.trim() ? 100 : 1);

export function runContractChecks(rulebook: Rulebook, opts: CheckOptions = {}): ContractAnomaly[] {
  const out: ContractAnomaly[] = [];
  const add = (code: ContractAnomalyCode, path: string | null, message: string, refs: SourceRef[], detail: Record<string, unknown> = {}) => {
    let id = `${code}:${path ?? ""}`;
    for (let n = 2; out.some((a) => a.id === id); n++) id = `${code}:${path ?? ""}#${n}`;
    out.push({ id, code, severity: SEVERITY[code], message, path, refs, detail, resolution: null });
  };
  const tol = tolerance(rulebook);
  // MULTI_PATIENT_ESTIMATE: shown beside the questions, never asked (isNotice); the master holds nothing it could change
  const estimate = (gi: number, label: string, e: Estimate, refs: SourceRef[]) => {
    const g = rulebook.budgetGrids[gi];
    add("MULTI_PATIENT_ESTIMATE", `/budgetGrids/${gi}`, `${g ? `${g.label}: ` : ""}"${label}" (${dollars(e.cents)}) is the total for ${e.patients} patients (${e.patients} × ${dollars(e.perPatientCents)}), not a per-patient total, so nothing is billed from it`, refs, { label, ...e });
  };
  for (const n of opts.notes ?? []) if (n.kind === "estimate" && n.estimate) estimate(Number(n.path?.split("/")[2]), n.topic, n.estimate, n.source ? [n.source] : []);

  rulebook.budgetGrids.forEach((g, gi) => {
    const gp = `/budgetGrids/${gi}`;
    // VISIT_TOTAL_MISMATCH
    g.visits.forEach((v, vi) => {
      const vp = `${gp}/visits/${vi}`;
      if (v.procedureSubtotalCents !== null && v.overheadCents !== null) {
        const expected = v.procedureSubtotalCents + v.overheadCents + (v.nonProcedureCents ?? 0);
        if (Math.abs(expected - v.totalCents) > tol)
          add("VISIT_TOTAL_MISMATCH", `${vp}/totalCents`, `${g.label} ${v.name}: printed total ${dollars(v.totalCents)} ≠ subtotal + overhead + non-procedure ${dollars(expected)}`, refsOf(v.prov), {
            expected,
            actual: v.totalCents,
          });
      }
      // Grid cells vs printed subtotals. Compared as one sum: contracts disagree on whether staff
      // fees count as "procedure" (Shah puts coordinator/physician fees in the procedure subtotal).
      const cellsOf = (cat?: "procedure" | "non_procedure") =>
        g.procedures.filter((p) => !cat || p.category === cat).map((p) => p.cells[v.code]).filter((c): c is number => typeof c === "number");
      const hasProcedureRows = cellsOf("procedure").length > 0;
      const [cells, printed, field] = hasProcedureRows
        ? [cellsOf(), v.procedureSubtotalCents === null ? null : v.procedureSubtotalCents + (v.nonProcedureCents ?? 0), "procedureSubtotalCents"]
        : [cellsOf("non_procedure"), v.nonProcedureCents, "nonProcedureCents"]; // summary grid: only stipend-type rows
      if (printed !== null && cells.length) {
        const cellSum = sum(cells);
        if (Math.abs(cellSum - printed) > tol)
          add("VISIT_TOTAL_MISMATCH", `${vp}/${field}`, `${g.label} ${v.name}: printed subtotals ${dollars(printed)} ≠ sum of grid cells ${dollars(cellSum)}`, refsOf(v.prov), {
            expected: cellSum,
            actual: printed,
          });
      }
    });

    // PER_PATIENT_TOTAL_MISMATCH
    const totals = [...g.visits].sort((a, b) => a.order - b.order).map((v) => v.totalCents);
    // A summary row may total a column (subtotal, overhead, stipend…) rather than the visit totals.
    const columnSums = [
      ...(["procedureSubtotalCents", "overheadCents", "nonProcedureCents"] as const).map((f) => sum(g.visits.map((v) => v[f] ?? 0))),
      ...g.procedures.map((p) => sum(Object.values(p.cells).filter((c): c is number => typeof c === "number"))),
    ];
    // a saved read may still hold a total for several patients here (the read now takes it out: splitEstimates): a notice, never compared
    const several = multiPatientTotals(g);
    for (const { index, ...e } of several) estimate(gi, g.perPatientTotals[index]!.label, e, refsOf(g.perPatientTotals[index]!.prov, g.prov));
    g.perPatientTotals.forEach((t, ti) => {
      if (several.some((e) => e.index === ti)) return;
      const best = closestBlockExclusion(totals, t.cents);
      const isColumnTotal = columnSums.some((s) => s > 0 && Math.abs(s - t.cents) <= tol * totals.length);
      if (best.diff > tol * totals.length && !isColumnTotal)
        add("PER_PATIENT_TOTAL_MISMATCH", `${gp}/perPatientTotals/${ti}/cents`, `${g.label} "${t.label}": printed per-patient total ${dollars(t.cents)} does not match the visit totals (sum of all visits ${dollars(sum(totals))})`, refsOf(t.prov, g.prov), {
          expected: sum(totals),
          actual: t.cents,
        });
    });

    // OVERHEAD_LABEL_MISMATCH
    if (g.statedOverheadPct !== null) {
      const vs = g.visits.filter((v) => v.overheadCents !== null && v.procedureSubtotalCents !== null && v.procedureSubtotalCents > 0);
      if (vs.length) {
        const oh = sum(vs.map((v) => v.overheadCents!));
        const pctProc = (100 * oh) / sum(vs.map((v) => v.procedureSubtotalCents!));
        const pctAll = (100 * oh) / sum(vs.map((v) => v.procedureSubtotalCents! + (v.nonProcedureCents ?? 0)));
        // ponytail: ±0.5 percentage points on the aggregate covers whole-dollar rounding per visit.
        const ok = [pctProc, pctAll].some((p) => Math.abs(p - g.statedOverheadPct!) <= 0.5);
        if (!ok) {
          const computed = Math.abs(pctProc - g.statedOverheadPct) < Math.abs(pctAll - g.statedOverheadPct) ? pctProc : pctAll;
          add("OVERHEAD_LABEL_MISMATCH", `${gp}/statedOverheadPct`, `${g.label}: labelled overhead ${g.statedOverheadPct}% but the printed amounts compute to ${computed.toFixed(1)}%`, refsOf(g.prov), {
            stated: g.statedOverheadPct,
            computed: Math.round(computed * 10) / 10,
          });
        }
      }
    }

    // HEADER_MISMATCH
    const study = rulebook.study;
    if (g.header.investigator && !sameName(g.header.investigator, study.investigator.value))
      add("HEADER_MISMATCH", `${gp}/header/investigator`, `${g.label}: grid header names PI "${g.header.investigator}", contract PI is "${study.investigator.value}"`, refsOf(g.prov, study.investigator.prov), {
        grid: g.header.investigator,
        study: study.investigator.value,
      });
    if (g.header.siteName && !sameName(g.header.siteName, study.siteName.value))
      add("HEADER_MISMATCH", `${gp}/header/siteName`, `${g.label}: grid header names site "${g.header.siteName}", contract site is "${study.siteName.value}"`, refsOf(g.prov, study.siteName.prov), {
        grid: g.header.siteName,
        study: study.siteName.value,
      });

    // DUPLICATE_ITEM, within one table: the same procedure on two rows of this grid, both priced at a visit. A
    // scheduled-visit price in the grid and an unscheduled or repeat price among the invoiceables is standard budgeting,
    // never flagged; so are the same words on rows that price different visits (a procedure split across sections).
    const rows = new Map<string, number[]>();
    g.procedures.forEach((p, pi) => {
      if (norm(p.name)) rows.set(norm(p.name), [...(rows.get(norm(p.name)) ?? []), pi]);
    });
    for (const idxs of rows.values()) {
      const [first, ...rest] = idxs;
      if (first === undefined) continue;
      const priced = (pi: number) => Object.entries(g.procedures[pi]!.cells).flatMap(([v, c]) => (typeof c === "number" ? [[v, c] as const] : []));
      for (const pi of rest) {
        // each later row is compared with the earlier ones: a visit both price is a conflicting or a redundant rate
        const shared = idxs.filter((o) => o < pi).flatMap((o) => priced(o).filter(([v]) => priced(pi).some(([w]) => w === v)).map(([v]) => v));
        if (shared.length) {
          const p = g.procedures[pi]!;
          add("DUPLICATE_ITEM", `${gp}/procedures/${pi}`, `"${p.name}" is listed twice in ${g.label} and priced twice at visit(s) ${[...new Set(shared)].join(", ")}`, refsOf(p.prov, g.procedures[first]!.prov), { otherRows: idxs.filter((o) => o < pi).map((o) => `${gp}/procedures/${o}`), visits: [...new Set(shared)] });
        }
      }
    }
  });

  // DUPLICATE_ITEM among the invoiceables: the same item listed twice, at the same or different amounts.
  rulebook.invoiceables.forEach((inv, ii) => {
    const first = rulebook.invoiceables.findIndex((o) => norm(o.name) === norm(inv.name));
    if (norm(inv.name) && first !== ii)
      add("DUPLICATE_ITEM", `/invoiceables/${ii}`, `Invoiceable "${inv.name}" is listed twice${rulebook.invoiceables[first]!.amountCents === inv.amountCents ? "" : " at different amounts"}`, refsOf(inv.prov, rulebook.invoiceables[first]!.prov), { otherInvoiceable: `/invoiceables/${first}` });
  });

  // GRID_CONFLICT: ≥2 grids for the same arm that price anything differently, a single cell included (two that agree on
  // every total can still bill a visit's procedures differently), and no governing grid chosen. Grids that price the
  // same are billed once (billedGrids), with nothing to ask.
  if (rulebook.governingGridId === null) {
    const byArm = new Map<string, number[]>();
    rulebook.budgetGrids.forEach((g, i) => byArm.set(norm(g.arm ?? ""), [...(byArm.get(norm(g.arm ?? "")) ?? []), i]));
    for (const idxs of byArm.values()) {
      if (idxs.length < 2) continue;
      const grids = idxs.map((i) => rulebook.budgetGrids[i]!);
      if (new Set(grids.map(gridPrices)).size > 1)
        add("GRID_CONFLICT", `/budgetGrids/${idxs[0]}`, `${grids.length} budget grids for ${grids[0]!.arm ?? "the study"} disagree (${grids.map((g) => g.label).join(" vs ")}); choose the governing grid`, refsOf(...grids.map((g) => g.prov)), {
          gridIds: grids.map((g) => g.id),
          perPatient: Object.fromEntries(grids.map((g) => [g.id, g.perPatientTotals.map((t) => t.cents)])),
        });
    }
  }

  // MISSING_REFERENCED_DOC. An amendment uploaded without the agreement it amends refers to documents that were never
  // going to be there (the agreement, its own earlier amendments), so one question covers them all: not one per document.
  const missing = rulebook.referencedDocuments.flatMap((d, i) => (d.present ? [] : [{ d, i }]));
  const amendsOnly = rulebook.documents.some((d) => d.kind === "amendment") && !rulebook.documents.some((d) => PARENT_KINDS.has(d.kind));
  if (amendsOnly) {
    const listed = missing.map(({ d }) => `${d.description}${d.date ? ` (${d.date})` : ""}`);
    add(
      "MISSING_REFERENCED_DOC",
      null,
      `The agreement this amendment changes isn't uploaded${listed.length ? `, and neither ${listed.length === 1 ? "is" : "are"} the ${listed.length === 1 ? "document" : "documents"} it refers to: ${listed.join("; ")}` : ""}. Terms that depend on ${listed.length ? "them" : "it"} are unverified`,
      refsOf(...missing.map(({ d }) => d.prov)),
      { consolidated: true, referenced: missing.map(({ d }) => ({ description: d.description, date: d.date })) },
    );
  } else
    for (const { d, i } of missing)
      add("MISSING_REFERENCED_DOC", `/referencedDocuments/${i}`, `Referenced document not uploaded: ${d.description}${d.date ? ` (${d.date})` : ""}. Terms that depend on it are unverified.`, refsOf(d.prov), {
        description: d.description,
        date: d.date,
      });

  // REQUIRED_MISSING
  for (const f of ["sponsor", "protocol", "siteName", "investigator"] as const) {
    if (!rulebook.study[f].value.trim()) add("REQUIRED_MISSING", `/study/${f}/value`, `Study ${f} not found`, [], { field: f });
  }
  if (!rulebook.budgetGrids.length) add("REQUIRED_MISSING", "/budgetGrids", "No budget grid found", [], { field: "budgetGrids" });
  rulebook.invoiceables.forEach((inv, i) => {
    if (inv.amountCents === null && inv.amountWithOverheadCents === null && inv.basis !== "actual_cost")
      add("REQUIRED_MISSING", `/invoiceables/${i}/amountCents`, `Invoiceable "${inv.name}" has no amount`, refsOf(inv.prov), { name: inv.name });
  });
  rulebook.siteFees.forEach((f, i) => {
    if (f.amountCents === null && f.trigger !== "actual_cost")
      add("REQUIRED_MISSING", `/siteFees/${i}/amountCents`, `Site fee "${f.name}" has no amount`, refsOf(f.prov), { name: f.name });
  });
  if (rulebook.screenFail && rulebook.screenFail.basis === "fixed" && rulebook.screenFail.amountCents === null)
    add("REQUIRED_MISSING", "/screenFail/amountCents", "Fixed screen-fail fee has no amount", refsOf(rulebook.screenFail.prov));

  // RETROACTIVE_NO_DATE
  const af = rulebook.appliesFrom;
  const retroNote = opts.notes?.find((n) => n.kind === "retroactive_no_date");
  if (af.value === null && (retroNote || /retroactiv/i.test(af.prov.source?.quote ?? "")))
    add("RETROACTIVE_NO_DATE", "/appliesFrom/value", "Amendment says it is retroactive but gives no start date", refsOf(af.prov, retroNote?.source ? { ...af.prov, source: retroNote.source } : null));

  // AMBIGUOUS_TERM
  if (rulebook.overhead.appliesTo.value === "unspecified")
    add("AMBIGUOUS_TERM", "/overhead/appliesTo/value", "Contract does not say clearly which lines overhead applies to", refsOf(rulebook.overhead.appliesTo.prov));
  opts.notes
    ?.filter((n) => n.kind === "ambiguous")
    .forEach((n) => add("AMBIGUOUS_TERM", n.path, `Ambiguous: ${n.topic}`, n.source ? [n.source] : [], { topic: n.topic }));

  // UNREADABLE_PAGE
  opts.pages
    ?.filter((p) => !p.readable)
    .forEach((p) => add("UNREADABLE_PAGE", null, `Page ${p.page} of document ${p.documentId} could not be read; enter its values manually if it has any`, [{ documentId: p.documentId, page: p.page }], { documentId: p.documentId, page: p.page }));

  // LOW_CONFIDENCE
  for (const { path, prov } of provenances(rulebook)) {
    if (prov.method === "ai" && prov.confidence < LOW_CONFIDENCE)
      add("LOW_CONFIDENCE", path, `Low extraction confidence (${prov.confidence.toFixed(2)}) at ${path}`, refsOf(prov), { confidence: prov.confidence });
  }

  // AI_DISAGREEMENT — one anomaly per item (grid row, visit, invoiceable…), listing every differing value.
  // A misread row otherwise raised one anomaly per visit column (24 for one McAllen row).
  if (opts.crossRead) {
    const groups = new Map<string, Comparison[]>();
    for (const d of compareRulebooks(rulebook, opts.crossRead)) {
      // A value the second reader merely skipped says nothing about a misread by the primary.
      if (d.agree || d.cross === undefined) continue;
      groups.set(d.item, [...(groups.get(d.item) ?? []), d]);
    }
    for (const ds of groups.values()) {
      const [first] = ds as [Comparison, ...Comparison[]];
      const message =
        ds.length === 1
          ? `Second read disagrees at ${first.label}: primary ${fmt(first.primary)}, cross-read ${fmt(first.cross)}`
          : `Second read disagrees on ${ds.length} values${first.name ? ` of "${first.name}"` : ""}: ${ds
              .slice(0, 4)
              .map((d) => `${d.label.replace(/^.*" /, "")} ${fmt(d.primary)} vs ${fmt(d.cross)}`)
              .join("; ")}${ds.length > 4 ? "; …" : ""}`;
      add("AI_DISAGREEMENT", first.path, message, refsOf(provAt(rulebook, first.path)), {
        claude: first.primary,
        openai: first.cross,
        ...(ds.length > 1 ? { fields: ds.map((d) => ({ path: d.path, label: d.label, claude: d.primary, openai: d.cross })) } : {}),
      });
    }
  }

  // TEXT_LAYER_MISMATCH — digital PDFs carry their own text: every amount read from a page that has a
  // text layer must be printed on the page its prov cites. Matched per page, not per document: small amounts
  // recur across a contract ($100 misread as $101 hides behind a $101 hourly rate elsewhere). One anomaly per item.
  // ponytail: a set of amounts per page, so a grid cell misread as another price on the same page ($34 → $35)
  // passes. Upgrade: match each grid row to its own text line and compare the cells in order.
  const textPages = (opts.pages ?? []).filter((p): p is PageInfo & { printed: number[] } => !!p.printed);
  if (textPages.length) {
    const onPage = new Map(textPages.map((p) => [`${p.documentId}#${p.page}`, new Set(p.printed)]));
    for (const it of amountItems(rulebook)) {
      const src = it.prov.source;
      const cited = src && onPage.get(`${src.documentId}#${src.page}`);
      if (!src || !cited) continue;
      const missing = it.amounts
        .filter((a) => !cited.has(a.cents))
        .map((a) => ({ ...a, path: `${it.path}/${a.field}`, printedOn: textPages.filter((p) => p.documentId === src.documentId && p.printed.includes(a.cents)).map((p) => p.page) }));
      if (!missing.length) continue;
      const where = (pages: number[]) => (pages.length ? `printed on page ${pages.slice(0, 3).join(", ")}${pages.length > 3 ? ", …" : ""}` : "not printed anywhere in the PDF's text");
      add(
        "TEXT_LAYER_MISMATCH",
        missing[0]!.path,
        `"${it.name}": ${missing
          .slice(0, 4)
          .map((a) => `${a.field.replace("cells/", "")} ${dollars(a.cents)} (${where(a.printedOn)})`)
          .join("; ")}${missing.length > 4 ? "; …" : ""}, but the cited page ${src.page} doesn't show it`,
        [src],
        { missing: missing.map(({ path, cents, printedOn }) => ({ path, cents, printedOn })) },
      );
    }
  }

  return out;
}

/** Every non-zero money amount in the rulebook, grouped by the item (visit, grid row, fee…) whose prov cites it. */
function amountItems(rb: Rulebook) {
  const items: { path: string; name: string; prov: Provenance; amounts: { field: string; cents: number }[] }[] = [];
  const item = (path: string, name: string, prov: Provenance, fields: [string, number | null | "invoiceable"][]) => {
    const amounts = fields.filter((f): f is [string, number] => typeof f[1] === "number" && f[1] !== 0).map(([field, cents]) => ({ field, cents }));
    if (amounts.length) items.push({ path, name, prov, amounts });
  };
  rb.budgetGrids.forEach((g, gi) => {
    const gp = `/budgetGrids/${gi}`;
    g.visits.forEach((v, vi) =>
      item(`${gp}/visits/${vi}`, `${g.label} ${v.name}`, v.prov, [
        ["procedureSubtotalCents", v.procedureSubtotalCents],
        ["overheadCents", v.overheadCents],
        ["nonProcedureCents", v.nonProcedureCents],
        ["totalCents", v.totalCents],
      ]),
    );
    g.procedures.forEach((p, pi) => item(`${gp}/procedures/${pi}`, p.name, p.prov, [["unitCents", p.unitCents], ...Object.entries(p.cells).map(([k, c]): [string, number | "invoiceable"] => [`cells/${k}`, c])]));
    g.perPatientTotals.forEach((t, ti) => item(`${gp}/perPatientTotals/${ti}`, t.label, t.prov, [["cents", t.cents]]));
  });
  rb.invoiceables.forEach((x, i) => item(`/invoiceables/${i}`, x.name, x.prov, [["amountCents", x.amountCents], ["amountWithOverheadCents", x.amountWithOverheadCents]]));
  rb.siteFees.forEach((x, i) => item(`/siteFees/${i}`, x.name, x.prov, [["amountCents", x.amountCents]]));
  if (rb.screenFail) item("/screenFail", "Screen failure", rb.screenFail.prov, [["amountCents", rb.screenFail.amountCents]]);
  return items;
}

/** Below this many non-space characters a page's text layer is a stamp (e.g. a Docusign envelope ID), not the page. */
export const MIN_PAGE_TEXT = 200;

/**
 * Money-like numbers in a page's text, in cents; undefined when the page has no real text layer.
 * Digit runs of 8+ without thousands separators (account, routing, phone numbers) are dropped, never kept; so is a
 * number with more than two decimals (parseCents: no amount is a fraction of a cent).
 */
export function printedAmounts(text: string): number[] | undefined {
  if (text.replace(/\s/g, "").length < MIN_PAGE_TEXT) return undefined;
  const out = new Set<number>();
  for (const [m] of text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const whole = m.split(".")[0]!;
    if (!whole.includes(",") && whole.length >= 8) continue;
    const cents = parseCents(m);
    if (cents !== null && cents > 0) out.add(cents);
  }
  return [...out].sort((a, b) => a - b);
}

const fmt = (v: unknown) => (v === undefined ? "(missing)" : JSON.stringify(v));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Smallest |printed − (all visits − one contiguous block)|. Handles totals that leave out a
 * run of visits (e.g. "double-blind only" skips the open-label block; unscheduled/ET at the end).
 * ponytail: heuristic, O(n²); can hide a real mismatch that happens to equal some block sum. Upgrade: a
 * visit→total mapping in the schema.
 */
function closestBlockExclusion(totals: number[], printed: number) {
  const all = sum(totals);
  let diff = Math.abs(all - printed);
  for (let i = 0; i < totals.length; i++) {
    let block = 0;
    for (let j = i; j < totals.length; j++) {
      block += totals[j]!;
      diff = Math.min(diff, Math.abs(all - block - printed));
    }
  }
  return { diff };
}

// ---------- names ----------

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const STOP = new Set(["the", "of", "and", "a", "fee", "fees", "per", "for", "to", "in", "visit", "cost", "costs", "llc", "inc", "md", "do", "dr", "phd", "mph"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\bm\.d\.?|\bd\.o\.?(?=\s|,|$)/g, " ")
    .replace(/\bdct\b/g, " discovery clinical trials ")
    .split(/[^a-z0-9]+/)
    .map((w) => w.replace(/s$/, ""))
    .filter((w) => w.length > 1 && !STOP.has(w));
export const sharesWord = (a: string, b: string) => {
  const wb = new Set(words(b));
  if (words(a).some((w) => w.length > 2 && wb.has(w))) return true;
  // Compound spellings: "Start-up" ~ "Administrative startup", "Close out Fee" ~ "Close-out".
  const joined = (x: string) => words(x.replace(/(\w)[- ](?=\w)/g, "$1"));
  const [na, nb] = [norm(a), norm(b)];
  return joined(a).some((w) => w.length > 3 && nb.includes(w)) || joined(b).some((w) => w.length > 3 && na.includes(w));
};
/** Same person/site if one's significant words are a subset of the other's ("Pankajkumar G. Shah, M.D." ~ "Pankajkumar Shah"). */
export function sameName(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return true;
  const [small, big] = wa.length <= wb.length ? [wa, new Set(wb)] : [wb, new Set(wa)];
  return small.every((w) => big.has(w));
}

// ---------- provenance walking ----------

/** Every `prov` in the rulebook with the JSON pointer of the value it describes. */
function provenances(rb: Rulebook): { path: string; prov: Provenance }[] {
  const out: { path: string; prov: Provenance }[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "prov") out.push({ path: "value" in v ? `${path}/value` : path || "/", prov: x as Provenance });
        else walk(x, `${path}/${k}`);
      }
    }
  };
  walk(rb, "");
  return out;
}

/** Provenance governing a JSON pointer: nearest ancestor object carrying `prov`. */
export function provAt(rb: Rulebook, path: string): Provenance | null {
  const parts = path.split("/").slice(1);
  let found: Provenance | null = null;
  let cur: unknown = rb;
  for (const p of parts) {
    if (cur && typeof cur === "object" && "prov" in cur) found = (cur as { prov: Provenance }).prov;
    cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
  }
  if (cur && typeof cur === "object" && "prov" in cur) found = (cur as { prov: Provenance }).prov;
  return found;
}

// ---------- cross-read comparison ----------

type Comparison = { key: string; item: string; name: string; path: string; label: string; primary: unknown; cross: unknown; agree: boolean };

type Field = { item: string; itemPath: string; path: string; label: string; value: unknown; name: string };

/** Flatten the money terms and rules to stable keys (not array indexes), so two independent reads align. */
function flatten(rb: Rulebook): Map<string, Field> {
  const m = new Map<string, Field>();
  const put = (item: string, itemPath: string, field: string, path: string, label: string, value: unknown, name = "") =>
    m.set(`${item}.${field}`, { item, itemPath, path, label, value, name });
  const scalar = (key: string, path: string, label: string, value: unknown) => put(key, path, "v", path, label, value);
  const keyed = <T>(items: T[], keyOf: (t: T) => string) => {
    const seen = new Map<string, number>();
    return items.map((t, i) => {
      const k = keyOf(t);
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return { t, i, k: n ? `${k}#${n}` : k };
    });
  };

  scalar("overhead.pct", "/overhead/pct/value", "overhead %", rb.overhead.pct.value);
  // Only amounts, percentages, counts, days and dates are cross-checked. Classification labels
  // (overhead scope, payment mode, fee trigger, cap kind) differ by interpretation, not misreading,
  // and flooded review with noise; human review covers them.
  scalar("payment.netDays", "/payment/netDays/value", "payment net days", rb.payment.netDays.value);
  scalar("appliesFrom", "/appliesFrom/value", "applies from", rb.appliesFrom.value);
  scalar("holdback.pct", "/holdback/pct", "holdback %", rb.holdback?.pct ?? null);
  const sf = rb.screenFail;
  scalar("screenFail.amount", "/screenFail/amountCents", "screen fail amount", sf?.amountCents ?? null);
  scalar("screenFail.cap", "/screenFail/cap", "screen fail cap", sf ? { n: sf.cap.n, ratio: sf.cap.ratio } : null);
  scalar("overpayment.refundDays", "/overpayment/refundDays", "overpayment refund days", rb.overpayment?.refundDays ?? null);
  for (const { t, i, k } of keyed(rb.deadlines, (d) => d.kind)) put(`deadline.${k}`, `/deadlines/${i}`, "value", `/deadlines/${i}/value`, `deadline ${k}`, t.value);
  for (const { t, i, k } of keyed(rb.invoiceables, (x) => norm(x.code ?? "") + "|" + norm(x.name))) {
    const ip = `/invoiceables/${i}`;
    put(`inv.${k}`, ip, "amount", `${ip}/amountCents`, `invoiceable "${t.name}" amount`, t.amountCents, t.name);
    put(`inv.${k}`, ip, "amountOH", `${ip}/amountWithOverheadCents`, `invoiceable "${t.name}" amount with overhead`, t.amountWithOverheadCents, t.name);
    put(`inv.${k}`, ip, "cap", `${ip}/cap`, `invoiceable "${t.name}" cap`, { n: t.cap.n, ratio: t.cap.ratio }, t.name);
  }
  for (const { t, i, k } of keyed(rb.siteFees, (x) => norm(x.code ?? "") + "|" + norm(x.name))) {
    const ip = `/siteFees/${i}`;
    put(`fee.${k}`, ip, "amount", `${ip}/amountCents`, `site fee "${t.name}" amount`, t.amountCents, t.name);
  }
  for (const { t: g, i: gi, k: gk } of keyed(rb.budgetGrids, (g) => norm(g.arm ?? "") || "grid")) {
    const gp = `/budgetGrids/${gi}`;
    put(`grid.${gk}`, gp, "statedOH", `${gp}/statedOverheadPct`, `${g.label} stated overhead`, g.statedOverheadPct);
    for (const { t, i: ti, k: tk } of keyed(g.perPatientTotals, (t) => norm(t.label)))
      put(`grid.${gk}.pp.${tk}`, `${gp}/perPatientTotals/${ti}`, "cents", `${gp}/perPatientTotals/${ti}/cents`, `${g.label} per-patient "${t.label}"`, t.cents, t.label);
    // Cross-read visit codes are remapped onto the primary's by matchGrids(), so codes line up here.
    for (const { t: v, i: vi, k: vk } of keyed(g.visits, (v) => norm(v.code))) {
      const vp = `${gp}/visits/${vi}`;
      for (const f of ["totalCents", "procedureSubtotalCents", "overheadCents", "nonProcedureCents"] as const)
        put(`grid.${gk}.visit.${vk}`, vp, f, `${vp}/${f}`, `${g.label} ${v.name} ${f}`, v[f]);
    }
    for (const { t: p, i: pi, k: pk } of keyed(g.procedures, (p) => norm(p.code ?? "") + "|" + norm(p.name))) {
      const pp = `${gp}/procedures/${pi}`;
      put(`grid.${gk}.proc.${pk}`, pp, "unit", `${pp}/unitCents`, `${g.label} "${p.name}" unit price`, p.unitCents, p.name);
      for (const [vc, cell] of Object.entries(p.cells)) put(`grid.${gk}.proc.${pk}`, pp, `cell.${norm(vc)}`, `${pp}/cells/${vc}`, `${g.label} "${p.name}" at ${vc}`, cell, p.name);
    }
  }
  return m;
}

/**
 * Field-by-field comparison of two independent reads. An item one read lacks entirely
 * (an invoiceable, visit, procedure, grid) is reported once, not once per field.
 */
export function compareRulebooks(primary: Rulebook, cross: Rulebook): Comparison[] {
  const a = flatten(primary);
  const b = alignNames(a, flatten(matchGrids(primary, cross)));
  const itemsA = new Set([...a.values()].map((f) => f.item));
  const itemsB = new Set([...b.values()].map((f) => f.item));
  const out: Comparison[] = [];
  const reported = new Set<string>();
  for (const [key, x] of a) {
    if (!itemsB.has(x.item)) {
      if (!reported.has(x.item)) out.push({ key: x.item, item: x.item, name: x.name, path: x.itemPath, label: x.label, primary: "present", cross: undefined, agree: false });
      reported.add(x.item);
      continue;
    }
    const y = b.get(key);
    out.push({ key, item: x.item, name: x.name, path: x.path, label: x.label, primary: x.value, cross: y?.value, agree: JSON.stringify(x.value) === JSON.stringify(y?.value) });
  }
  for (const y of b.values()) {
    if (itemsA.has(y.item) || reported.has(y.item)) continue;
    reported.add(y.item);
    // Found only by the cross-read: anchor on the parent list in the primary.
    out.push({ key: y.item, item: y.item, name: y.name, path: y.itemPath.replace(/\/\d+$/, ""), label: y.label, primary: undefined, cross: "present", agree: false });
  }
  return out;
}

/**
 * Re-key cross-read items whose name differs only in wording ("Administrative startup (non-refundable)"
 * vs "Administrative startup") onto the primary item's key, so they are compared field by field
 * instead of being reported as one missing item on each side.
 */
function alignNames(a: Map<string, Field>, b: Map<string, Field>): Map<string, Field> {
  const section = (item: string) => item.replace(/\.[^.]*$/, "");
  const names = (m: Map<string, Field>) => new Map([...m.values()].filter((f) => f.name).map((f) => [f.item, f.name]));
  const itemsA = names(a);
  const itemsB = names(b);
  const rename = new Map<string, string>();
  const taken = new Set<string>([...itemsB.keys()].filter((k) => itemsA.has(k)));
  for (const [ib, nameB] of itemsB) {
    if (itemsA.has(ib)) continue;
    const match = [...itemsA].find(([ia, nameA]) => !taken.has(ia) && section(ia) === section(ib) && (sameName(nameA, nameB) || sharesWord(nameA, nameB)));
    if (match) {
      rename.set(ib, match[0]);
      taken.add(match[0]);
    }
  }
  if (!rename.size) return b;
  const out = new Map<string, Field>();
  for (const [key, f] of b) {
    const to = rename.get(f.item);
    out.set(to ? to + key.slice(f.item.length) : key, to ? { ...f, item: to } : f);
  }
  return out;
}

/**
 * Reorder the cross-read's grids to pair with the primary's by their numbers (most shared visit
 * totals), since the two reads may list grids in a different order or under different titles.
 * Paired grids get the primary's arm so they share a key in flatten().
 */
function matchGrids(primary: Rulebook, cross: Rulebook): Rulebook {
  const totals = (g: BudgetGrid) => g.visits.map((v) => v.totalCents);
  const overlap = (a: number[], b: number[]) => {
    const pool = [...b];
    return a.filter((x) => {
      const i = pool.indexOf(x);
      return i >= 0 && pool.splice(i, 1).length > 0;
    }).length;
  };
  const left = cross.budgetGrids.map((g, i) => ({ g, i }));
  const paired: BudgetGrid[] = [];
  for (const pg of primary.budgetGrids) {
    let best = -1;
    let bestScore = 0;
    left.forEach(({ g }, j) => {
      const sc = overlap(totals(pg), totals(g));
      if (sc > bestScore) [best, bestScore] = [j, sc];
    });
    if (best >= 0) paired.push(recodeVisits(pg, { ...left.splice(best, 1)[0]!.g, arm: pg.arm, label: pg.label }));
  }
  return { ...cross, budgetGrids: [...paired, ...left.map(({ g }) => g)] };
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const numbers = (s: string) => tokens(s).filter((t) => /^\d+$/.test(t)).join(" ");

/**
 * Rename the cross grid's visit codes to the primary's ("Screening" → "SCR"): by name first
 * (numbers must agree, so "Wk 20" never pairs with "Wk 24"), then by column position among the rest.
 */
function recodeVisits(primary: BudgetGrid, cross: BudgetGrid): BudgetGrid {
  const score = (a: Visit, b: Visit) => {
    const [na, nb] = [`${a.code} ${a.name}`, `${b.code} ${b.name}`];
    if (numbers(na) !== numbers(nb)) return 0;
    const tb = new Set(tokens(nb));
    return tokens(na).filter((t) => tb.has(t)).length;
  };
  const map = new Map<string, string>();
  const freeP = [...primary.visits].sort((a, b) => a.order - b.order);
  const freeC = [...cross.visits].sort((a, b) => a.order - b.order);
  for (const c of [...freeC]) {
    let best: Visit | null = null;
    let bestScore = 0;
    for (const p of freeP) {
      const sc = score(p, c);
      if (sc > bestScore) [best, bestScore] = [p, sc];
    }
    if (best) {
      map.set(c.code, best.code);
      freeP.splice(freeP.indexOf(best), 1);
      freeC.splice(freeC.indexOf(c), 1);
    }
  }
  freeC.forEach((c, i) => freeP[i] && map.set(c.code, freeP[i]!.code));
  const to = (code: string) => map.get(code) ?? code;
  return {
    ...cross,
    visits: cross.visits.map((v) => ({ ...v, code: to(v.code) })),
    procedures: cross.procedures.map((p) => ({ ...p, cells: Object.fromEntries(Object.entries(p.cells).map(([k, v]) => [to(k), v])) })),
  };
}

type Visit = BudgetGrid["visits"][number];
