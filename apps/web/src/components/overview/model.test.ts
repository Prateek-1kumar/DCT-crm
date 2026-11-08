import { describe, expect, it } from "vitest";
import { question, rulebook, term, version } from "@/components/version/fixtures";
import { bigGrid } from "../rulebook/test-data";
import { amendmentCards, buildOverview, describeItem, flagPill, GROUPS, NONE_FOUND, proofreadCounts, saysNoHoldback, termCard } from "./model";

const v = (terms = [] as ReturnType<typeof term>[], extra = {}) => version({ rulebook: rulebook({ terms, ...extra }) });
const section = (sections: ReturnType<typeof buildOverview>, key: string) => sections.find((s) => s.key === key);

describe("core cards", () => {
  it("are always present, muted, when the contract has none", () => {
    const core = section(buildOverview(v()), "core")!;
    expect(core.cards.map((c) => c.label)).toEqual(["Payment terms", "Holdback", "Overhead", "Screen failures", "Unscheduled visits", "Invoice deadlines"]);
    expect(core.cards.every((c) => c.muted && c.value === NONE_FOUND && c.evidence === null)).toBe(true);
  });

  it("say the contract withholds nothing only when a term says so", () => {
    const holdback = (terms: ReturnType<typeof term>[]) => section(buildOverview(v(terms)), "core")!.cards.find((c) => c.key === "none-holdback")!.detail;
    expect(holdback([])).toBe("No holdback found");
    expect(holdback([term("a", { category: "site_fee", holdbackApplies: "no" })])).toBe("The contract doesn't withhold anything");
    expect(saysNoHoldback([term("a", { holdbackApplies: "no" }), term("b", { holdbackApplies: "unclear" })])).toBe(false);
  });

  it("show the real term instead of a none card, and don't repeat it in a group", () => {
    const sections = buildOverview(v([term("pay", { category: "payment_terms", name: "Net 45", deadline: "45 days" })]));
    expect(section(sections, "core")!.cards.find((c) => c.termId === "pay")).toBeTruthy();
    expect(section(sections, "payment")).toBeUndefined();
  });

  it("take overhead from the grids when no term states it", () => {
    const sections = buildOverview(v([], { grids: [bigGrid()] }));
    const card = section(sections, "core")!.cards.find((c) => c.label === "Overhead")!;
    expect(card.muted).toBe(false);
    expect(card.value).toBe("28%");
  });
});

describe("grouping and order", () => {
  it("lists the groups in the accountant's order", () => {
    expect(GROUPS.map((g) => g.title)).toEqual([
      "Payment and invoicing",
      "Holdback and overhead",
      "Site fees",
      "Recurring fees",
      "Invoiceable items",
      "Conditional procedures, screen failures and unscheduled visits",
      "Stipends, travel and bonuses",
      "Caps and limits",
      "Other",
    ]);
  });

  it("gives every term a card with no cap, and puts attention first inside a group", () => {
    const many = Array.from({ length: 40 }, (_, i) => term(`fee${i}`, { category: "site_fee", name: `Fee ${i}`, amountCents: 1000 * (i + 1) }));
    many[30] = term("fee30", { category: "site_fee", name: "Fee 30", evidence: "none" });
    many[35] = term("fee35", { category: "site_fee", name: "Fee 35", billing: "unknown" });
    many[39] = term("fee39", { category: "site_fee", name: "Fee 39" });
    const cards = section(buildOverview(v(many, { questions: [question("q", { about: { target: "term", id: "fee39" } })] })), "site_fees")!.cards;
    expect(cards).toHaveLength(40);
    expect(cards.slice(0, 3).map((c) => c.termId).sort()).toEqual(["fee30", "fee35", "fee39"]);
    expect(cards.find((c) => c.termId === "fee39")!.needsDecision).toBe(true);
    expect(cards.at(-1)!.attention).toBe(false);
  });

  it("flags unclear holdback and overhead as attention", () => {
    const decision = new Set<string>();
    expect(termCard(term("a", { holdbackApplies: "unclear" }), decision).attention).toBe(true);
    expect(termCard(term("b", { overheadApplies: "unclear" }), decision).attention).toBe(true);
    expect(termCard(term("c"), decision).attention).toBe(false);
  });

  it("puts each category under its heading", () => {
    const sections = buildOverview(v([term("a", { category: "bonus" }), term("b", { category: "cap_or_limit" }), term("c", { category: "other" }), term("d", { category: "conditional_procedure" })]));
    expect(sections.map((s) => s.key)).toEqual(["core", "conditional", "stipends", "caps", "other"]);
  });
});

describe("card values", () => {
  it("formats big money and moves cap and conditions into the detail", () => {
    const c = termCard(term("a", { category: "site_fee", amountCents: 98765432100, unit: "one time", trigger: "On signing", cap: { kind: "count", value: 3, period: "year", text: "" }, conditions: "Non-refundable", billing: "auto_paid" }), new Set());
    expect(c.value).toBe("$987,654,321.00 one time");
    expect(c.detail).toBe("On signing · capped at 3 per year · Non-refundable");
    expect(c.label).toBe("One-time fee");
  });

  it("shows the formula as the rule, and a deadline as the headline when there is no amount", () => {
    expect(termCard(term("a", { formula: "100% V1 + 75% V2" }), new Set()).value).toBe("100% V1 + 75% V2");
    const d = termCard(term("b", { category: "deadline", deadline: "Within 60 days of the visit" }), new Set());
    expect(d.value).toBe("Within 60 days of the visit");
    expect(d.detail).toBe("");
  });

  it("says whether holdback and overhead apply, in plain words, never as codes", () => {
    const c = termCard(term("a", { amountCents: 100, holdbackApplies: "yes", overheadApplies: "added" }), new Set());
    expect(c.detail).toBe("Holdback applies · Overhead is added on top");
    expect(c.detail).not.toMatch(/_|n\/a/);
  });

  it("falls back to a plain sentence when there is nothing to show", () => {
    expect(termCard(term("a"), new Set()).value).toBe("No amount stated");
  });
});

describe("arm and amendment cards", () => {
  it("shows the per-patient total with the arm name as the label", () => {
    const arms = section(buildOverview(v([], { grids: [bigGrid(), bigGrid({ id: "g2", arm: null, name: "Open label", grandTotalCents: null })] })), "arms")!.cards;
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({ label: "Arm A — Investigational product, twice daily", value: "$1,580,372.34", evidence: "math" });
  });

  it("shows when each amendment applies", () => {
    const rb = rulebook({
      study: { ...rulebook().study, documents: [
        { doc: "Amendment 2.pdf", role: "amendment", hasMoney: true, supersedes: [], effectiveFrom: "2026-03-01", retroactive: true, notes: null },
        { doc: "Amendment 3.pdf", role: "amendment", hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null },
        { doc: "Protocol.pdf", role: "protocol", hasMoney: false, supersedes: [], effectiveFrom: null, retroactive: false, notes: null },
      ] },
    });
    const cards = amendmentCards(version({ rulebook: rb }));
    expect(cards.map((c) => c.detail)).toEqual(["Applies from March 1, 2026 · also applies to work already done", "Start date not stated"]);
  });
});

describe("search", () => {
  const terms = [
    term("a", { category: "site_fee", name: "Startup fee", amountCents: 500000, source: { doc: "C.pdf", page: 1, quote: "payable upon IRB approval" } }),
    term("b", { category: "site_fee", name: "Archiving", amountCents: 120000, notes: "Per box" }),
  ];
  const ids = (q: string) => buildOverview(v(terms), q).flatMap((s) => s.cards.map((c) => c.termId)).filter(Boolean);
  it("matches names, amounts, quotes and notes, ignoring case", () => {
    expect(ids("STARTUP")).toEqual(["a"]);
    expect(ids("5,000")).toEqual(["a"]);
    expect(ids("$1200")).toEqual(["b"]);
    expect(ids("irb approval")).toEqual(["a"]);
    expect(ids("per box")).toEqual(["b"]);
  });
  it("matches nothing for a word that isn't there", () => {
    expect(buildOverview(v(terms), "zebra")).toEqual([]);
  });
});

describe("proofread counts", () => {
  it("counts terms and grid cells that someone proofread", () => {
    const ver = { ...v([term("a"), term("b")]), proofreads: [{ item: "a", by: "Ana", at: "" }, { item: "a", by: "Bo", at: "" }, { item: "grid:g1:0:1", by: "Ana", at: "" }] };
    expect(proofreadCounts(ver)).toEqual({ terms: 1, termsTotal: 2, cells: 1, flagged: 0 });
  });
});

describe("flags", () => {
  const at = "2026-11-03T10:00:00Z";
  const flag = (item: string, by = "Ana", note = "Looks off") => ({ item, by, note, at });
  const fees = [term("a", { category: "site_fee", name: "Startup fee" }), term("b", { category: "site_fee", name: "Archiving" }), term("c", { category: "site_fee", name: "Courier" })];
  const withFlags = (flags: ReturnType<typeof flag>[], terms = fees, extra = {}) => ({ ...v(terms, extra), flags });
  const cards = (ver: ReturnType<typeof withFlags>, q = "") => section(buildOverview(ver, q), "site_fees")!.cards;

  it("counts a flagged card as needing attention, so it sorts first in its group", () => {
    const list = cards(withFlags([flag("c")]));
    expect(list.map((c) => c.termId)).toEqual(["c", "a", "b"]);
    expect(list[0]!.attention).toBe(true);
    expect(list[0]!.flags).toHaveLength(1);
  });

  it("finds a card by the words of a flag's note", () => {
    const ver = withFlags([flag("b", "Ana", "Total is for a different arm")]);
    expect(cards(ver, "different arm").map((c) => c.termId)).toEqual(["b"]);
    expect(buildOverview(ver, "zebra")).toEqual([]);
  });

  it("shows the first note cut to about 60 characters, with the rest in the title and a count of the others", () => {
    const long = "x".repeat(100);
    const pill = flagPill([{ by: "Ana", note: long, at, where: null }, { by: "Bo", note: "Wrong date", at, where: "ECG, Week 4" }, { by: "Cy", note: "Same", at, where: null }])!;
    expect(pill.text).toBe(`Flagged by Ana: ${"x".repeat(59)}…`);
    expect(pill.more).toBe(2);
    expect(pill.title).toBe(`Ana: ${long}\nBo (ECG, Week 4): Wrong date\nCy: Same`);
    expect(flagPill([{ by: "Ana", note: "short", at, where: null }])).toMatchObject({ text: "Flagged by Ana: short", more: 0 });
    expect(flagPill([])).toBeNull();
  });

  it("puts a grid-cell flag on that grid's card only, naming the cell", () => {
    const ver = withFlags([flag("grid:g1:0:1", "Ana", "Wrong amount"), flag("grid:g2:0:0", "Bo", "Other grid")], [], { grids: [bigGrid(), bigGrid({ id: "g2", arm: "Arm B" })] });
    const arms = section(buildOverview(ver), "arms")!.cards;
    const g1 = arms.find((c) => c.key === "arm-g1")!;
    expect(g1.flags).toEqual([{ by: "Ana", note: "Wrong amount", at, where: "Comprehensive metabolic panel with extended lipid profile and long description, Week 4" }]);
    expect(arms.find((c) => c.key === "arm-g2")!.flags.map((f) => f.by)).toEqual(["Bo"]);
    expect(g1.attention).toBe(true);
  });

  it("counts flagged items once each in the checks tally", () => {
    expect(proofreadCounts(withFlags([flag("a"), flag("a", "Bo"), flag("grid:g1:0:0")])).flagged).toBe(2);
  });

  it("describes a flagged term or cell, and nothing for a line the rulebook no longer has", () => {
    const rb = rulebook({ terms: [term("a", { name: "Startup fee", amountCents: 500000 })], grids: [bigGrid()] });
    expect(describeItem(rb, "a")).toMatchObject({ name: "Startup fee", value: "$5,000.00", ref: { target: "term", id: "a" } });
    expect(describeItem(rb, "grid:g1:1:0")).toMatchObject({ name: "ECG, Screening", value: "$98.00", ref: { target: "grid", id: "g1", row: 1, col: 0 } });
    expect(describeItem(rb, "gone")).toBeNull();
    expect(describeItem(rb, "grid:g9:0:0")).toBeNull();
  });
});
