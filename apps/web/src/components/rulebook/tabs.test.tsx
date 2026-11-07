import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { question, rulebook, term, version } from "@/components/version/fixtures";
import { BudgetGridTab } from "./BudgetGridTab";
import { FeesTab } from "./FeesTab";
import { PaymentTermsTab } from "./PaymentTermsTab";
import { bigGrid } from "./test-data";

afterEach(cleanup);

const common = { query: "", me: "Bo", onShow: vi.fn(), onProofread: vi.fn() };
const terms = [
  term("a", { category: "site_fee", name: "Archiving", amountCents: 500000, billing: "auto_paid", trigger: "At closeout", deadline: "30 days", cap: { kind: "amount", value: 1000000, period: null, text: "" }, evidence: "math" }),
  term("b", { category: "screen_failure", name: "Screen failure visit with a very long description that must wrap inside its cell", amountCents: 12000, billing: "unknown", evidence: "none" }),
  term("c", { category: "payment_terms", name: "Net 45", deadline: "45 days", evidence: "quote" }),
];
const ver = version({ rulebook: rulebook({ terms, grids: [bigGrid()], questions: [question("q", { about: { target: "term", id: "a" } })] }), proofreads: [{ item: "a", by: "Ana", at: "" }] });

describe("FeesTab", () => {
  it("lists fee terms only, attention first, with billing in plain words and proof", () => {
    render(<FeesTab {...common} version={ver} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Paid automatically")).toBeTruthy();
    expect(within(rows[1]!).getByText("Not settled yet")).toBeTruthy();
    expect(within(rows[0]!).getByText("$5,000.00")).toBeTruthy();
    expect(within(rows[0]!).getByText("capped at $10,000.00")).toBeTruthy();
    expect(within(rows[0]!).getByText("Totals add up")).toBeTruthy();
    expect(within(rows[0]!).getByText("Needs your decision")).toBeTruthy();
    expect(screen.queryByText("Net 45")).toBeNull();
  });

  it("calls onShow, and says so when the query matches nothing or the contract has no fees", () => {
    const onShow = vi.fn();
    render(<FeesTab {...common} onShow={onShow} version={ver} />);
    fireEvent.click(screen.getByRole("button", { name: "Show in the contract: Archiving" }));
    expect(onShow).toHaveBeenCalledWith({ target: "term", id: "a" });
    cleanup();
    render(<FeesTab {...common} query="zebra" version={ver} />);
    expect(screen.getByText("Nothing matches “zebra”")).toBeTruthy();
    cleanup();
    render(<FeesTab {...common} version={version({ rulebook: rulebook() })} />);
    expect(screen.getByText("No fees found in this contract")).toBeTruthy();
  });
});

describe("PaymentTermsTab", () => {
  it("lists payment rules only", () => {
    render(<PaymentTermsTab {...common} version={ver} />);
    expect(screen.getByText("Net 45")).toBeTruthy();
    expect(screen.queryByText("Archiving")).toBeNull();
  });
});

describe("BudgetGridTab", () => {
  it("shows each grid with the per-patient total, overhead rate, proof and proofread count", () => {
    const withMarks = version({ rulebook: ver.rulebook, proofreads: [{ item: "grid:g1:0:0", by: "Ana", at: "" }] });
    render(<BudgetGridTab {...common} version={withMarks} />);
    expect(screen.getAllByText("$1,580,372.34").length).toBeGreaterThan(0);
    expect(screen.getByText("Overhead 28%")).toBeTruthy();
    expect(screen.getByText("Totals add up")).toBeTruthy();
    expect(screen.getByText("1 cell proofread by Ana")).toBeTruthy();
    expect(screen.getByText("Invoice")).toBeTruthy();
  });

  it("calls onShow with the clicked cell and marks doubtful cells", () => {
    const onShow = vi.fn();
    const amount = { box: [0, 0, 1, 1] as [number, number, number, number], text: "", cents: 9800, status: "captured" as const, ref: { target: "grid" as const, id: "g1", row: 1, col: 0 }, reason: null, doubt: "unsure" as const, line: "" };
    const coverage = { pages: [{ documentId: "d", doc: "d", page: 1, kind: "text" as const, clauses: [], amounts: [amount] }], totals: { amounts: 1, captured: 1, decided: 0, setAside: 0, missing: 0 } };
    render(<BudgetGridTab {...common} onShow={onShow} coverage={coverage} version={ver} />);
    expect(screen.getByText("1 cell to double-check")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /ECG, Screening/ }));
    expect(onShow).toHaveBeenCalledWith({ target: "grid", id: "g1", row: 1, col: 0 });
  });

  it("explains an empty rulebook and a query with no match", () => {
    render(<BudgetGridTab {...common} version={version({ rulebook: rulebook() })} />);
    expect(screen.getByText("No budget grid found in this contract")).toBeTruthy();
    cleanup();
    render(<BudgetGridTab {...common} query="zebra" version={ver} />);
    expect(screen.getByText("Nothing matches “zebra”")).toBeTruthy();
  });
});
