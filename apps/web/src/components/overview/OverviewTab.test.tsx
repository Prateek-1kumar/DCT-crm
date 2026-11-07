import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { question, rulebook, term, version } from "@/components/version/fixtures";
import { bigGrid } from "../rulebook/test-data";
import { OverviewTab } from "./OverviewTab";

afterEach(cleanup);

const terms = [
  term("fee", { category: "site_fee", name: "Startup fee for the coordinating site and all of its satellite clinics", amountCents: 98765432100, unit: "one time", evidence: "math", source: { doc: "C.pdf", page: 2, quote: "a startup fee" } }),
  term("hb", { category: "holdback", name: "Holdback", amountCents: null, formula: "10% until closeout", evidence: "none", holdbackApplies: "unclear" }),
];
const coverage = { pages: [], totals: { amounts: 12, captured: 9, decided: 1, setAside: 1, missing: 1 } };

function setup(over: Partial<Parameters<typeof OverviewTab>[0]> = {}) {
  const onShow = vi.fn();
  const onProofread = vi.fn();
  const ver = version({ rulebook: rulebook({ terms, grids: [bigGrid()], questions: [question("q1", { about: { target: "term", id: "hb" } })] }), proofreads: [{ item: "fee", by: "Ana", at: "" }] });
  render(<OverviewTab version={ver} coverage={coverage} query="" me="Bo" onShow={onShow} onProofread={onProofread} {...over} />);
  return { onShow, onProofread, ver };
}

describe("OverviewTab", () => {
  it("shows a card for every term under counted headings, with core cards muted when absent", () => {
    setup();
    expect(screen.getByRole("heading", { name: /Key rules/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Site fees/ }).textContent).toContain("1");
    expect(screen.getByRole("heading", { name: /Per-patient totals/ })).toBeTruthy();
    expect(screen.getAllByText("None found in this contract").length).toBe(4); // overhead is taken from the grid
    expect(screen.getByText("$987,654,321.00 one time")).toBeTruthy();
    expect(screen.getByText("$1,580,372.34")).toBeTruthy();
  });

  it("shows proof badge with its explanation, who proofread, and the decision pill", () => {
    setup();
    expect(screen.getAllByText("Totals add up")[0]!.getAttribute("title")).toMatch(/add up/);
    expect(screen.getByText("Proofread by Ana")).toBeTruthy();
    expect(screen.getAllByText("Needs your decision")).toHaveLength(1);
    expect(screen.getByText("Not clear whether the holdback applies")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/two_reads|auto_paid|house_rule|n\/a/);
  });

  it("calls onShow with the term or the grid", () => {
    const { onShow } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Show in the contract: Startup fee/ }));
    expect(onShow).toHaveBeenLastCalledWith({ target: "term", id: "fee" });
    fireEvent.click(screen.getAllByRole("button", { name: /Show in the contract: Arm A/ })[0]!);
    expect(onShow).toHaveBeenLastCalledWith({ target: "grid", id: "g1", row: -1, col: 0 });
  });

  it("marks and unmarks the signed-in person's proofread", () => {
    const { onProofread } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Mark as proofread: Startup fee/ }));
    expect(onProofread).toHaveBeenLastCalledWith(["fee"], true);
    cleanup();
    const again = setup({ me: "Ana" });
    fireEvent.click(screen.getByRole("button", { name: /Remove my proofread mark from Startup fee/ }));
    expect(again.onProofread).toHaveBeenLastCalledWith(["fee"], false);
  });

  it("hides the mark button until a name is chosen", () => {
    setup({ me: null });
    expect(screen.queryByRole("button", { name: /Mark as proofread/ })).toBeNull();
  });

  it("filters by the query and says so when nothing matches", () => {
    setup({ query: "satellite" });
    expect(screen.getByText(/Startup fee/)).toBeTruthy();
    expect(screen.queryByText("None found in this contract")).toBeNull();
    cleanup();
    setup({ query: "zebra" });
    expect(screen.getByText("Nothing matches “zebra”")).toBeTruthy();
  });

  it("explains how the numbers were checked, with a Proofread button that calls back", () => {
    const onOpenProofread = vi.fn();
    setup({ onOpenProofread });
    const panel = screen.getByRole("heading", { name: "How the numbers were checked" }).closest("section")!;
    expect(within(panel).getByText("Matched the contract")).toBeTruthy();
    expect(within(panel).getByText(/1 dollar amount printed in the contract isn't in the rulebook yet/)).toBeTruthy();
    expect(within(panel).getByText(/1 of 2 terms proofread by a person/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Proofread" }));
    expect(onOpenProofread).toHaveBeenCalled();
  });

  it("explains a missing coverage, and an unread rulebook", () => {
    setup({ coverage: undefined });
    expect(screen.getByText(/isn't ready yet/)).toBeTruthy();
    cleanup();
    render(<OverviewTab version={version({ rulebook: null })} query="" me={null} onShow={() => {}} onProofread={() => {}} />);
    expect(screen.getByText("Nothing to show yet")).toBeTruthy();
  });
});
