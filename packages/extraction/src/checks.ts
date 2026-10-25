import type { BudgetGrid, ContractAnomaly, ContractAnomalyCode, Provenance, Rulebook, SourceRef } from "@dct/shared";

/** Pure, deterministic contract checks. No AI. */

export type PageInfo = {
  documentId: string;
  page: number;
  kind: "terms" | "budget_grid" | "invoiceables" | "signatures" | "boilerplate";
  readable: boolean;
};

/**
 * Things the AI noticed that the Rulebook schema has no field for yet (see docs/phase-1/extraction.md,
 * "Proposed shared-schema changes"). Carried on ExtractionOutput.notes.
 */
export type ExtractionNote = {
  kind: "ambiguous" | "retroactive_no_date";
  topic: string;
  /** JSON pointer of the affected rulebook value, if any. */
  path: string | null;
  source: SourceRef | null;
};

export type CheckOptions = {
  crossRead?: Rulebook | null;
  /** ExtractionOutput.pages: enables UNREADABLE_PAGE. */
  pages?: PageInfo[];
  /** ExtractionOutput.notes: enables note-based AMBIGUOUS_TERM / RETROACTIVE_NO_DATE. */
  notes?: ExtractionNote[];
};

export const LOW_CONFIDENCE = 0.8;

const SEVERITY: Record<ContractAnomalyCode, ContractAnomaly["severity"]> = {
  GRID_CONFLICT: "blocker",
  HEADER_MISMATCH: "blocker",
  RETROACTIVE_NO_DATE: "blocker",
  UNREADABLE_PAGE: "blocker",
  REQUIRED_MISSING: "warning",
  VISIT_TOTAL_MISMATCH: "warning",
  PER_PATIENT_TOTAL_MISMATCH: "warning",
  OVERHEAD_LABEL_MISMATCH: "warning",
  DUPLICATE_ITEM: "warning",
  MISSING_REFERENCED_DOC: "warning",
  AI_DISAGREEMENT: "warning",
  AMBIGUOUS_TERM: "warning",
  LOW_CONFIDENCE: "info",
};

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const refsOf = (...provs: (Provenance | null | undefined)[]) =>
  provs.flatMap((p) => (p?.source ? [p.source] : [])).filter((r, i, a) => a.findIndex((x) => x.documentId === r.documentId && x.page === r.page) === i);

/** Allowed difference in cents: the contract rounds to whole dollars → ±$1, else ±1 cent of float noise. */
export const tolerance = (rb: Rulebook) => (rb.rounding.value === "printed_amounts" ? 100 : 1);

export function runContractChecks(rulebook: Rulebook, opts: CheckOptions = {}): ContractAnomaly[] {
  const out: ContractAnomaly[] = [];
  const add = (code: ContractAnomalyCode, path: string | null, message: string, refs: SourceRef[], detail: Record<string, unknown> = {}) => {
    let id = `${code}:${path ?? ""}`;
    for (let n = 2; out.some((a) => a.id === id); n++) id = `${code}:${path ?? ""}#${n}`;
    out.push({ id, code, severity: SEVERITY[code], message, path, refs, detail, resolution: null });
  };
  const tol = tolerance(rulebook);

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
      for (const [field, category] of [
        ["procedureSubtotalCents", "procedure"],
        ["nonProcedureCents", "non_procedure"],
      ] as const) {
        const printed = v[field];
        const cells = g.procedures.filter((p) => p.category === category).map((p) => p.cells[v.code]).filter((c): c is number => typeof c === "number");
        if (printed === null || cells.length === 0) continue;
        const sum = cells.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - printed) > tol)
          add("VISIT_TOTAL_MISMATCH", `${vp}/${field}`, `${g.label} ${v.name}: printed ${category.replace("_", "-")} subtotal ${dollars(printed)} ≠ sum of grid cells ${dollars(sum)}`, refsOf(v.prov), {
            expected: sum,
            actual: printed,
          });
      }
    });

    // PER_PATIENT_TOTAL_MISMATCH
    const totals = [...g.visits].sort((a, b) => a.order - b.order).map((v) => v.totalCents);
    g.perPatientTotals.forEach((t, ti) => {
      const best = closestBlockExclusion(totals, t.cents);
      if (best.diff > tol * totals.length)
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

    // DUPLICATE_ITEM: priced inside a visit AND billable as an invoiceable.
    g.procedures.forEach((p, pi) => {
      const priced = Object.entries(p.cells).filter((e): e is [string, number] => typeof e[1] === "number");
      if (!priced.length) return;
      rulebook.invoiceables.forEach((inv, ii) => {
        const codeMatch = !!p.code && !!inv.code && norm(p.code) === norm(inv.code);
        const nameMatch = norm(p.name) === norm(inv.name);
        const fuzzy = sharesWord(p.name, inv.name) && priced.some(([, c]) => c === inv.amountCents || c === inv.amountWithOverheadCents);
        if (codeMatch || nameMatch || fuzzy)
          add("DUPLICATE_ITEM", `${gp}/procedures/${pi}`, `"${p.name}" is paid inside ${g.label} visit(s) ${priced.map(([v]) => v).join(", ")} and also listed as invoiceable "${inv.name}"`, refsOf(p.prov, inv.prov), {
            invoiceablePath: `/invoiceables/${ii}`,
            visits: priced.map(([v]) => v),
          });
      });
    });
  });

  // GRID_CONFLICT: ≥2 grids for the same arm with different visit totals and no governing grid chosen.
  if (rulebook.governingGridId === null) {
    const byArm = new Map<string, number[]>();
    rulebook.budgetGrids.forEach((g, i) => byArm.set(norm(g.arm ?? ""), [...(byArm.get(norm(g.arm ?? "")) ?? []), i]));
    for (const idxs of byArm.values()) {
      if (idxs.length < 2) continue;
      const sig = (g: BudgetGrid) => JSON.stringify([g.visits.map((v) => v.totalCents).sort((a, b) => a - b), g.perPatientTotals.map((t) => t.cents).sort((a, b) => a - b)]);
      const grids = idxs.map((i) => rulebook.budgetGrids[i]!);
      if (new Set(grids.map(sig)).size > 1)
        add("GRID_CONFLICT", `/budgetGrids/${idxs[0]}`, `${grids.length} budget grids for ${grids[0]!.arm ?? "the study"} disagree (${grids.map((g) => g.label).join(" vs ")}); choose the governing grid`, refsOf(...grids.map((g) => g.prov)), {
          gridIds: grids.map((g) => g.id),
          perPatient: Object.fromEntries(grids.map((g) => [g.id, g.perPatientTotals.map((t) => t.cents)])),
        });
    }
  }

  // MISSING_REFERENCED_DOC
  rulebook.referencedDocuments.forEach((d, i) => {
    if (!d.present)
      add("MISSING_REFERENCED_DOC", `/referencedDocuments/${i}`, `Referenced document not uploaded: ${d.description}${d.date ? ` (${d.date})` : ""}. Terms that depend on it are unverified.`, refsOf(d.prov), {
        description: d.description,
        date: d.date,
      });
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

  // AI_DISAGREEMENT
  if (opts.crossRead) {
    for (const d of compareRulebooks(rulebook, opts.crossRead)) {
      if (d.agree) continue;
      add("AI_DISAGREEMENT", d.path, `Second read disagrees at ${d.label}: primary ${fmt(d.primary)}, cross-read ${fmt(d.cross)}`, refsOf(provAt(rulebook, d.path)), {
        claude: d.primary,
        openai: d.cross,
      });
    }
  }

  return out;
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
const sharesWord = (a: string, b: string) => {
  const wb = new Set(words(b));
  return words(a).some((w) => w.length > 2 && wb.has(w));
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
export function provenances(rb: Rulebook): { path: string; prov: Provenance }[] {
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

export type Comparison = { key: string; path: string; label: string; primary: unknown; cross: unknown; agree: boolean };

type Field = { item: string; itemPath: string; path: string; label: string; value: unknown };

/** Flatten the money terms and rules to stable keys (not array indexes), so two independent reads align. */
function flatten(rb: Rulebook): Map<string, Field> {
  const m = new Map<string, Field>();
  const put = (item: string, itemPath: string, field: string, path: string, label: string, value: unknown) =>
    m.set(`${item}.${field}`, { item, itemPath, path, label, value });
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
  scalar("overhead.appliesTo", "/overhead/appliesTo/value", "overhead applies to", rb.overhead.appliesTo.value);
  for (const f of ["visitPayment", "frequency", "netDays"] as const) scalar(`payment.${f}`, `/payment/${f}/value`, `payment ${f}`, rb.payment[f].value);
  scalar("rounding", "/rounding/value", "rounding", rb.rounding.value);
  scalar("appliesFrom", "/appliesFrom/value", "applies from", rb.appliesFrom.value);
  scalar("holdback.pct", "/holdback/pct", "holdback %", rb.holdback?.pct ?? null);
  const sf = rb.screenFail;
  scalar("screenFail.amount", "/screenFail/amountCents", "screen fail amount", sf?.amountCents ?? null);
  scalar("screenFail.cap", "/screenFail/cap", "screen fail cap", sf?.cap ?? null);
  scalar("screenFail.basis", "/screenFail/basis", "screen fail basis", sf?.basis ?? null);
  scalar("overpayment.refundDays", "/overpayment/refundDays", "overpayment refund days", rb.overpayment?.refundDays ?? null);
  for (const { t, i, k } of keyed(rb.deadlines, (d) => d.kind)) put(`deadline.${k}`, `/deadlines/${i}`, "value", `/deadlines/${i}/value`, `deadline ${k}`, t.value);
  for (const { t, i, k } of keyed(rb.invoiceables, (x) => norm(x.code ?? "") + "|" + norm(x.name))) {
    const ip = `/invoiceables/${i}`;
    put(`inv.${k}`, ip, "amount", `${ip}/amountCents`, `invoiceable "${t.name}" amount`, t.amountCents);
    put(`inv.${k}`, ip, "amountOH", `${ip}/amountWithOverheadCents`, `invoiceable "${t.name}" amount with overhead`, t.amountWithOverheadCents);
    put(`inv.${k}`, ip, "cap", `${ip}/cap`, `invoiceable "${t.name}" cap`, t.cap);
  }
  for (const { t, i, k } of keyed(rb.siteFees, (x) => norm(x.code ?? "") + "|" + norm(x.name))) {
    const ip = `/siteFees/${i}`;
    put(`fee.${k}`, ip, "amount", `${ip}/amountCents`, `site fee "${t.name}" amount`, t.amountCents);
    put(`fee.${k}`, ip, "trigger", `${ip}/trigger`, `site fee "${t.name}" trigger`, t.trigger);
  }
  for (const { t: g, i: gi, k: gk } of keyed(rb.budgetGrids, (g) => norm(g.arm ?? "") || "grid")) {
    const gp = `/budgetGrids/${gi}`;
    put(`grid.${gk}`, gp, "statedOH", `${gp}/statedOverheadPct`, `${g.label} stated overhead`, g.statedOverheadPct);
    g.perPatientTotals.forEach((t, ti) => put(`grid.${gk}`, gp, `perPatient${ti}`, `${gp}/perPatientTotals/${ti}/cents`, `${g.label} per-patient "${t.label}"`, t.cents));
    for (const { t: v, i: vi, k: vk } of keyed(g.visits, (v) => norm(v.code))) {
      const vp = `${gp}/visits/${vi}`;
      for (const f of ["totalCents", "procedureSubtotalCents", "overheadCents", "nonProcedureCents"] as const)
        put(`grid.${gk}.visit.${vk}`, vp, f, `${vp}/${f}`, `${g.label} ${v.name} ${f}`, v[f]);
    }
    for (const { t: p, i: pi, k: pk } of keyed(g.procedures, (p) => norm(p.code ?? "") + "|" + norm(p.name))) {
      const pp = `${gp}/procedures/${pi}`;
      put(`grid.${gk}.proc.${pk}`, pp, "unit", `${pp}/unitCents`, `${g.label} "${p.name}" unit price`, p.unitCents);
      for (const [vc, cell] of Object.entries(p.cells)) put(`grid.${gk}.proc.${pk}`, pp, `cell.${norm(vc)}`, `${pp}/cells/${vc}`, `${g.label} "${p.name}" at ${vc}`, cell);
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
  const b = flatten(cross);
  const itemsA = new Set([...a.values()].map((f) => f.item));
  const itemsB = new Set([...b.values()].map((f) => f.item));
  const out: Comparison[] = [];
  const reported = new Set<string>();
  for (const [key, x] of a) {
    if (!itemsB.has(x.item)) {
      if (!reported.has(x.item)) out.push({ key: x.item, path: x.itemPath, label: x.label, primary: "present", cross: undefined, agree: false });
      reported.add(x.item);
      continue;
    }
    const y = b.get(key);
    out.push({ key, path: x.path, label: x.label, primary: x.value, cross: y?.value, agree: JSON.stringify(x.value) === JSON.stringify(y?.value) });
  }
  for (const y of b.values()) {
    if (itemsA.has(y.item) || reported.has(y.item)) continue;
    reported.add(y.item);
    // Found only by the cross-read: anchor on the parent list in the primary.
    out.push({ key: y.item, path: y.itemPath.replace(/\/\d+$/, ""), label: y.label, primary: undefined, cross: "present", agree: false });
  }
  return out;
}
