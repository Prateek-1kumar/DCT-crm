import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook, ValueEvidence } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { bindEvidence } from "../src/binder";
import { OFF_BY_DEFAULT, ocrCandidates, RULES, type Rule } from "../src/candidates";
import { readTextLayer, type TextPage } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/**
 * Noisy OCR numbers (the guide's Step 2.2, candidates.ts): which cents a word of our OCR may mean, and the binder using them
 * for words of our OCR only. Synthetic amounts only.
 */

const dollars = (...ds: number[]) => new Set(ds.map((d) => d * 100));
const has = (raw: string, d: number) => ocrCandidates(raw).has(d * 100);
/** Every rule on: what the guide's own form does, and what one switch per rule gives back. */
const ALL = new Set<Rule>();

describe("ocrCandidates, rule by rule", () => {
  it("the plain parse is always a candidate", () => {
    expect(ocrCandidates("$1,234.56")).toEqual(new Set([123456]));
    expect(ocrCandidates("185.00")).toEqual(dollars(185));
    expect(ocrCandidates("(12.50)").has(-1250)).toBe(true);
  });

  it("a comma, colon or hyphen before two final digits is the decimal point", () => {
    expect(has("185,00", 185)).toBe(true);
    expect(has("2.050,00", 2050)).toBe(true);
    expect(has("1,185,00", 1185)).toBe(true);
    expect(has("47:00", 47)).toBe(true);
    expect(has("172-00", 172)).toBe(true);
    expect(ocrCandidates("47:50")).toEqual(new Set([4750]));
    // never the guide's "-45" → ".45": a digit has to come first
    expect(ocrCandidates("-45").has(45)).toBe(false);
  });

  it("a dot as the thousands separator", () => {
    expect(has("4.070.00", 4070)).toBe(true);
    expect(has("4.070", 4070)).toBe(true);
    // "530.171" is 530171 dollars; 30171 once the leading 5 is taken for a "$" is the dollarAsFive rule, which is off by default
    expect(has("530.171", 530171)).toBe(true);
    expect(has("530.171", 30171)).toBe(false);
    expect(ocrCandidates("530.171", new Set()).has(3017100)).toBe(true);
  });

  it("two of the guide's rules are off by default, and only those (they gained no confirmed value on any scan)", () => {
    expect([...OFF_BY_DEFAULT].sort()).toEqual(["dollarAsFive", "missingPoint"]);
    expect([...RULES].filter((r) => !OFF_BY_DEFAULT.has(r)).sort()).toEqual(["decimal", "thousands"]);
  });

  it("a point lost before 00", () => {
    // off by default (it let planted decimal-point errors through); the rule itself still works when asked for
    expect(ocrCandidates("4500")).toEqual(new Set([450000]));
    expect(ocrCandidates("4500", new Set()).has(4500)).toBe(true); // 45.00, in cents
    expect(ocrCandidates("4500", new Set())).toEqual(new Set([450000, 4500]));
  });

  it("a leading 5 for a lost $: off by default, and one switch from on", () => {
    // off: "526" is $526, nothing else
    expect(ocrCandidates("526")).toEqual(new Set([52600]));
    expect(ocrCandidates("574")).toEqual(new Set([57400]));
    // on, only on a word with no $
    expect(ocrCandidates("526", new Set(["missingPoint"]))).toEqual(new Set([52600, 2600]));
    expect(ocrCandidates("574", ALL)).toEqual(new Set([57400, 7400]));
    expect(ocrCandidates("$526", ALL)).toEqual(new Set([52600]));
    // not on a word that ends in a two-decimal fraction: "55.00" is $55.00, never also $5.00 (15 planted digit errors on the scans)
    expect(ocrCandidates("55.00", ALL)).toEqual(new Set([5500]));
    expect(ocrCandidates("55,00", ALL).has(500)).toBe(false);
    expect(ocrCandidates("574:00", ALL).has(7400)).toBe(false);
    // nor on a two-digit whole number: "55" is $55, never also $5
    expect(ocrCandidates("55", ALL)).toEqual(new Set([5500]));
    // the guide's own examples have no fraction and work when the rule is on
    expect(ocrCandidates("530.171", ALL).has(3017100)).toBe(true);
    // never a free price, and never the 5 of a lone "5"
    expect(ocrCandidates("50.00", ALL).has(0)).toBe(false);
    expect(ocrCandidates("500", ALL).has(0)).toBe(false);
    expect(ocrCandidates("5", ALL)).toEqual(new Set([500]));
  });

  it("nothing wider: garbage, a third decimal and other shapes have no noisy reading", () => {
    expect(ocrCandidates("")).toEqual(new Set());
    expect(ocrCandidates("abc")).toEqual(new Set());
    expect(ocrCandidates("12.345.6")).toEqual(new Set());
    expect(ocrCandidates("1,2345")).toEqual(new Set());
    expect(ocrCandidates("25O.OE")).toEqual(new Set());
  });

  it("each rule can be switched off on its own (for measuring)", () => {
    for (const r of RULES) expect(ocrCandidates("526", new Set([r])).size).toBeLessThanOrEqual(2);
    expect(ocrCandidates("526", new Set(["dollarAsFive"]))).toEqual(new Set([52600]));
    expect(ocrCandidates("526", new Set(["missingPoint"]))).toEqual(new Set([52600, 2600]));
    expect(ocrCandidates("185,00", new Set(["decimal"]))).toEqual(new Set());
  });
});

// ---------- the binder ----------

type Text = [x: number, y: number, s: string];
const at = ([x, y, s]: Text) => `BT /F1 8 Tf ${x} ${792 - y} Td (${s}) Tj ET\n`;
async function textPage(texts: Text[]): Promise<TextPage> {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const filler: Text[] = [[40, 700, "This page continues the agreement between the parties and the site, as set out in full above."], [40, 720, "A second line of ordinary words keeps the page well above the threshold for a real text layer."], [40, 740, "A third line, because a page with fewer than two hundred characters of text is treated as a scan."]];
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, [...texts, ...filler].map(at).join("")));
  const path = join(mkdtempSync(join(tmpdir(), "dct-cand-")), "table.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return (await readTextLayer(path, "d1"))[0]!;
}
const asOcr = (p: TextPage, edit: (w: TextPage["words"][number]) => Partial<TextPage["words"][number]> = () => ({})): TextPage => ({ ...p, source: "ocr", words: p.words.map((w) => ({ ...w, conf: 0.99, ...edit(w) })) });

const on = { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } as const;
function grid(visits: [string, string][], rows: [name: string, unit: number, cells: Record<string, number>][]): Rulebook {
  const rb = makeRulebook();
  const g = rb.budgetGrids[0]!;
  g.prov = { ...on };
  g.statedOverheadPct = null;
  g.perPatientTotals = [];
  g.visits = visits.map(([code, name], i) => ({ code, name, order: i + 1, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: 0, autopay: true, prov: { ...on } }));
  g.procedures = rows.map(([name, unit, cells]) => ({ code: null, name, unitCents: unit * 100, overheadApplied: true, category: "procedure" as const, cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, v * 100])), prov: { ...on } }));
  return rb;
}
const ev = (rb: Rulebook, p: TextPage) => bindEvidence(rb, [p]).evidence;
const cell = (e: ValueEvidence[], row: number, visit: string) => e.find((x) => x.path === `/budgetGrids/0/procedures/${row}/cells/${visit}`);
const NOTED = /usual misreadings/;

describe("the binder, label path (no drawn table)", () => {
  const X = { name: 90, unit: 220, c1: 280, c2: 340, c3: 400 };
  const row = (c1: string, c2: string, c3: string): Text[] => [[X.name, 100, "Procedure"], [X.c1, 100, "V1"], [X.c2, 100, "V2"], [X.c3, 100, "V3"], [X.name, 120, "Blood draw"], [X.unit, 120, "200.00"], [X.c1, 120, c1], [X.c2, 120, c2], [X.c3, 120, c3]];
  const visits: [string, string][] = [["V1", "Screening"], ["V2", "Week 2"], ["V3", "Week 4"]];
  const read = (v1: number, v2: number, v3: number) => grid(visits, [["Blood draw", 200, { V1: v1, V2: v2, V3: v3 }]]);

  it("confirms a comma decimal and a colon decimal on a scan, and says it was a noisy match", async () => {
    const p = asOcr(await textPage(row("185,00", "47:00", "200.00")));
    const e = ev(read(185, 47, 200), p);
    expect(cell(e, 0, "V1")?.status).toBe("confirmed");
    expect(cell(e, 0, "V1")?.note).toMatch(NOTED);
    expect(cell(e, 0, "V2")?.status).toBe("confirmed");
    // a plain match carries no such note
    expect(cell(e, 0, "V3")).toMatchObject({ status: "confirmed", note: null });
  });

  it("the same words in a PDF's own text confirm nothing: exact there, as before", async () => {
    const p = await textPage(row("185,00", "74:00", "526"));
    const e = ev(read(185, 47, 26), p);
    expect(["V1", "V2", "V3"].map((v) => cell(e, 0, v)?.status)).not.toContain("confirmed");
    expect(cell(e, 0, "V3")?.status).toBe("conflict");
  });

  it("a leading 5 read for a $ is off by default: '526' confirms a read of 526 only, a read of 26 is a conflict", async () => {
    const p = asOcr(await textPage(row("526", "574", "200.00")));
    // the rule gained no confirmed value on any scan, so a read of 26 against a printed "526" is the planted digit error it looks like
    const lost = ev(read(26, 74, 200), p);
    expect(cell(lost, 0, "V1")?.status).toBe("conflict");
    expect(cell(lost, 0, "V2")?.status).toBe("conflict");
    // the read says 526: the plain parse matches, no noisy match is claimed
    const plain = ev(read(526, 574, 200), p);
    expect(cell(plain, 0, "V1")).toMatchObject({ status: "confirmed", note: null });
    expect(cell(plain, 0, "V2")).toMatchObject({ status: "confirmed", note: null });
  });

  it("a clean price that no candidate matches is still a conflict", async () => {
    const p = asOcr(await textPage(row("526", "250.00", "200.00")));
    const e = ev(read(99, 260, 200), p);
    expect(cell(e, 0, "V1")?.status).toBe("conflict");
    expect(cell(e, 0, "V2")?.status).toBe("conflict");
    // a garbled word is not a clean price: a different read there is asked, never a conflict, as before
    const g = ev(read(99, 74, 200), asOcr(await textPage(row("185,00", "47:00", "200.00"))));
    expect(cell(g, 0, "V1")?.status).toBe("ungrounded");
  });

  it("an unsure word still confirms nothing, noisy or not", async () => {
    const p = asOcr(await textPage(row("185,00", "47:00", "200.00")), (w) => (w.text === "185,00" ? { conf: 0.5 } : {}));
    expect(cell(ev(read(185, 47, 200), p), 0, "V1")?.status).toBe("ungrounded");
  });
});

describe("the binder, drawn table (cells planned by the prices they print)", () => {
  const U = [40, 160, 220, 280, 340, 400, 460];
  function drawn(table: (string | null)[][], source: TextPage["source"] = "ocr"): TextPage {
    const words: TextPage["words"] = [];
    table.forEach((row, r) =>
      row.forEach((text, k) => {
        if (!text) return;
        const [u0, v0] = [U[k]! + 4, 80 + 20 * r + 5];
        words.push({ text, rect: [u0, v0, u0 + 5 * text.length, v0 + 10], dir: 0, block: words.length, line: words.length, hidden: false, conf: 0.99 });
      }),
    );
    const ys = table.map((_, r) => 80 + 20 * r).concat(80 + 20 * table.length);
    const grids = [{ box: [U[0]!, ys[0]!, U.at(-1)!, ys.at(-1)!] as [number, number, number, number], xs: U, ys }];
    return { documentId: "d1", page: 1, width: 612, height: 792, source, words, hidden: 0, largePicture: false, grids };
  }
  const HEAD = ["Procedure", "Cost", "Week 4", "Week 8", "Week 12", "Total"];
  const visits: [string, string][] = [["T4", "Week 4"], ["T8", "Week 8"], ["T12", "Week 12"]];
  const read = (c: Record<string, number>, unit = 100) => grid(visits, [["Blood draw", unit, c]]);

  it("each noise class confirms its cell at its visit, one printed row confirming each cell once", () => {
    const p = drawn([HEAD, ["Venipuncture", "100.00", "100,00", "200:00", "300-00", "600.00"]]);
    const e = ev(read({ T4: 100, T8: 200, T12: 300 }), p);
    expect(["T4", "T8", "T12"].map((v) => cell(e, 0, v)?.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(["T4", "T8", "T12"].map((v) => !!cell(e, 0, v)?.note?.match(NOTED))).toEqual([true, true, true]);
    const dots = ev(read({ T4: 4070, T8: 4070, T12: 530171 }, 4070), drawn([HEAD, ["Venipuncture", "4.070.00", "4.070.00", "4.070", "530.171", "x"]]));
    expect(["T4", "T8", "T12"].map((v) => cell(dots, 0, v)?.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
  });

  it("a printed 55.00 never confirms a read of 5.00 (the dropped digit), whatever the rules", () => {
    const row = ["Venipuncture", "100.00", "55.00", "200.00", "300.00", "x"];
    const e = ev(read({ T4: 5, T8: 200, T12: 300 }), drawn([HEAD, row]));
    expect(cell(e, 0, "T4")?.status).not.toBe("confirmed");
  });

  it("a printed 4500 is not 45, and a printed 526 is not 26 (both rules are off by default)", () => {
    const e = ev(read({ T4: 45, T8: 26, T12: 74 }), drawn([HEAD, ["Venipuncture", "100.00", "4500", "526", "574", "x"]]));
    // a printed 4500 never confirms a read of 45: a hundredth of a price is the planted decimal-point error
    expect(cell(e, 0, "T4")?.status).not.toBe("confirmed");
    expect(cell(e, 0, "T8")?.status).not.toBe("confirmed");
    expect(cell(e, 0, "T12")?.status).not.toBe("confirmed");
    // the read says 526 and 4500: the plain parse matches, so there is nothing noisy to note
    const plain = ev(read({ T4: 4500, T8: 526, T12: 574 }), drawn([HEAD, ["Venipuncture", "100.00", "4500", "526", "574", "x"]]));
    expect(cell(plain, 0, "T8")).toMatchObject({ status: "confirmed", note: null });
  });

  it("a PDF's own text is exact: the same table as text confirms none of them", () => {
    const e = ev(read({ T4: 100, T8: 200, T12: 300 }), drawn([HEAD, ["Venipuncture", "100.00", "100,00", "200:00", "300-00", "600.00"]], "text"));
    expect(["T4", "T8", "T12"].map((v) => cell(e, 0, v)?.status)).not.toContain("confirmed");
  });

  it("never confirms a different price, or the right one at the wrong visit", () => {
    const p = drawn([HEAD, ["Venipuncture", "100.00", "100,00", "200:00", "300-00", "600.00"]]);
    for (const [v, d] of [["T4", 101], ["T8", 20], ["T12", 400]] as const) {
      const c = { T4: 100, T8: 200, T12: 300, [v]: d };
      expect(cell(ev(read(c), p), 0, v)?.status).not.toBe("confirmed");
    }
    // swapped visits: each value is printed in the row, but not at its own visit
    expect(cell(ev(read({ T4: 200, T8: 100, T12: 300 }), p), 0, "T4")?.status).not.toBe("confirmed");
  });
});
