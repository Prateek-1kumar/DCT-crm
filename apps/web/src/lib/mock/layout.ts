import type { PageBox, Rulebook } from "@dct/shared";
import { formatValue, labelFor } from "../format";
import { findProv } from "../pointer";

/**
 * SYNTHETIC: what a sample page prints and where, as fractions of the page. The evidence boxes (where the reading found
 * each number) and the drawn page both come from here, so a close-up always lands on the printed number, as it will
 * on a real PDF where the boxes come from the PDF's own text.
 */

type Box = [number, number, number, number];
export type Span = { text: string; box: Box; path?: string; item?: string; weight?: 400 | 600 | 700; anchor?: "start" | "end"; muted?: boolean };
type LayoutItem = { id: string; path: string | null; where: PageBox[]; lines: string[] };

const BOILER = [
  "The parties agree that the following terms govern payment for services performed under the Protocol.",
  "Amounts are stated in United States dollars and are inclusive of all applicable overhead unless noted.",
  "Institution shall maintain complete and accurate records supporting each invoice submitted hereunder.",
];

/** Every number in the master, as JSON pointers. */
export function numberPaths(rb: Rulebook): string[] {
  const out: string[] = [];
  const walk = (o: unknown, path: string) => {
    if (typeof o === "number") return void out.push(path);
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) if (k !== "prov" && k !== "order" && k !== "schemaVersion") walk(v, `${path}/${k}`);
  };
  walk(rb, "");
  return out;
}

const wrap = (t: string) => t.match(/.{1,96}(\s|$)/g)?.map((x) => x.trim()) ?? [t];

const unionBox = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  return [x0, y0, Math.max(...boxes.map((b) => b[0] + b[2])) - x0, Math.max(...boxes.map((b) => b[1] + b[3])) - y0];
};

/** `truthOf`: what the page prints for a value (the right answer where the reading got it wrong). */
export function layoutPage(rb: Rulebook, items: LayoutItem[], truthOf: (path: string) => unknown, docId: string, page: number, title = ""): Span[] {
  const out: Span[] = [];
  const show = (path: string) => formatValue(path, truthOf(path));
  // Budget tables print bare numbers in their cells, as real budgets usually do.
  const cellText = (path: string) => show(path).replace(/^\$/, "");
  const here = (path: string) => {
    const s = findProv(rb, path)?.source;
    return !!s && s.documentId === docId && s.page === page;
  };
  out.push({ text: title, box: [0.08, 0.1, 0.84, 0.024], weight: 700 });
  BOILER.slice(0, 1 + (page % 2)).forEach((t, i) => out.push({ text: t, box: [0.08, 0.135 + i * 0.026, 0.84, 0.022], muted: true }));
  let y = 0.21;

  // 1. Budget grids printed on this page, as tables: one row per procedure, one column per visit, then the visit totals.
  rb.budgetGrids.forEach((g, gi) => {
    const src = g.prov.source;
    if (!src || src.documentId !== docId || src.page !== page) return;
    const visits = [...g.visits].sort((a, b) => a.order - b.order);
    const L = 0.06;
    const labelW = 0.24;
    const unitW = 0.075;
    const colW = (0.94 - L - labelW - unitW) / Math.max(1, visits.length);
    const rowH = 0.02;
    const colX = (i: number) => L + labelW + unitW + i * colW;
    const cell = (i: number): Box => [colX(i), y, colW - 0.006, rowH];
    out.push({ text: g.label, box: [L, y, 0.6, 0.024], weight: 700 });
    if (g.statedOverheadPct !== null) out.push({ text: `Overhead ${show(`/budgetGrids/${gi}/statedOverheadPct`)}`, box: [0.74, y, 0.2, 0.024], path: `/budgetGrids/${gi}/statedOverheadPct`, anchor: "end", weight: 600 });
    y += 0.028;
    if (g.header.investigator || g.header.siteName)
      out.push({ text: [g.header.investigator && `Principal Investigator: ${g.header.investigator}`, g.header.siteName && `Site: ${g.header.siteName}`].filter(Boolean).join("  ·  "), box: [L, y, 0.88, 0.02], muted: true });
    y += 0.03;
    out.push({ text: "Procedure", box: [L, y, labelW, rowH], weight: 600, muted: true });
    out.push({ text: "Unit", box: [L + labelW, y, unitW - 0.006, rowH], weight: 600, muted: true, anchor: "end" });
    visits.forEach((v, i) => out.push({ text: v.code, box: cell(i), weight: 600, muted: true, anchor: "end" }));
    y += rowH + 0.006;
    g.procedures.forEach((p, pi) => {
      const base = `/budgetGrids/${gi}/procedures/${pi}`;
      out.push({ text: `${p.name}${p.code ? ` (${p.code})` : ""}`, box: [L, y, labelW - 0.01, rowH] });
      if (p.unitCents !== null) out.push({ text: cellText(`${base}/unitCents`), box: [L + labelW, y, unitW - 0.006, rowH], path: `${base}/unitCents`, anchor: "end" });
      visits.forEach((v, i) => {
        const c = p.cells[v.code];
        if (c === undefined) return;
        const path = `${base}/cells/${v.code}`;
        out.push(c === "invoiceable" ? { text: "Inv.", box: cell(i), anchor: "end", muted: true } : { text: cellText(path), box: cell(i), path, anchor: "end" });
      });
      y += rowH;
    });
    y += 0.006;
    const totals: [field: "procedureSubtotalCents" | "overheadCents" | "nonProcedureCents" | "totalCents", label: string][] = [
      ["procedureSubtotalCents", "Procedures"],
      ["overheadCents", "Overhead"],
      ["nonProcedureCents", "Staff and stipends"],
      ["totalCents", "Visit total"],
    ];
    for (const [field, label] of totals) {
      if (!g.visits.some((v) => v[field] !== null)) continue;
      const strong = field === "totalCents";
      out.push({ text: label, box: [L, y, labelW, rowH], weight: strong ? 700 : 600 });
      visits.forEach((v, i) => {
        if (v[field] === null) return;
        const path = `/budgetGrids/${gi}/visits/${g.visits.indexOf(v)}/${field}`;
        out.push({ text: cellText(path), box: cell(i), path, anchor: "end", weight: strong ? 700 : 400 });
      });
      y += rowH;
    }
    y += 0.012;
    g.perPatientTotals.forEach((t, ti) => {
      const path = `/budgetGrids/${gi}/perPatientTotals/${ti}/cents`;
      out.push({ text: `${t.label}:`, box: [L, y, 0.3, 0.022], weight: 600 });
      out.push({ text: show(path), box: [L + 0.3, y, 0.16, 0.022], path, weight: 700 });
      y += 0.028;
    });
    y += 0.02;
  });

  // 2. Every other number sourced to this page: its label, and the value set apart so a close-up frames just the number.
  const numbers = numberPaths(rb);
  for (const path of numbers.filter((p) => !p.startsWith("/budgetGrids/") && here(p))) {
    out.push({ text: labelFor(path, rb), box: [0.08, y, 0.6, 0.024] });
    out.push({ text: show(path), box: [0.7, y, 0.22, 0.024], path, anchor: "end", weight: 700 });
    y += 0.034;
  }

  // 3. Lines of questions that aren't about one printed number on this page (contract problems, terms to bill by hand…).
  const printed = new Set(numbers.filter(here));
  for (const it of items)
    it.where.forEach((w, i) => {
      const t = it.lines[i];
      if (!t || w.documentId !== docId || w.page !== page || (it.path && printed.has(it.path))) return;
      y += 0.008;
      for (const chunk of wrap(t)) {
        out.push({ text: chunk, box: [0.08, y, 0.84, 0.024], item: it.id, weight: 600 });
        y += 0.028;
      }
    });
  return out;
}

/** Where a value (or a question's own line) sits on a page, from the layout. */
export function boxOn(spans: Span[], q: { path?: string | null; item?: string }): Box | null {
  const byPath = q.path ? spans.find((s) => s.path === q.path) : undefined;
  return byPath?.box ?? (q.item ? unionBox(spans.filter((s) => s.item === q.item).map((s) => s.box)) : null);
}
