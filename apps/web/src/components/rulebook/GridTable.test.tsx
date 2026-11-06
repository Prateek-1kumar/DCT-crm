import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Grid } from "@dct/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GridTable } from "./GridTable";

const grid: Grid = {
  id: "g1",
  name: "Main budget",
  arm: "Arm A",
  doc: "Budget.pdf",
  pages: [1],
  visits: ["Screening", "Week 4"],
  overheadPct: 25,
  rows: [
    { name: "Blood draw", code: "36415", unitCostCents: 2500, cells: [2500, "Invoice"], printedRowTotalCents: 2500 },
    { name: "Spirometry", code: null, unitCostCents: null, cells: [9800, null], printedRowTotalCents: null },
  ],
  subtotal: [12300, 0],
  overhead: [3075, 0],
  additions: [{ name: "Travel stipend", cells: [5000, "Inc in PE"] }],
  total: [20375, 0],
  grandTotalCents: 20375,
  cellsReadTwice: [], acceptedAsPrinted: false,
};

afterEach(cleanup);

describe("GridTable", () => {
  it("shows items, visits, amounts, printed text and the grand total", () => {
    render(<GridTable grid={grid} />);
    const table = screen.getByRole("table", { name: "Main budget" });
    expect(within(table).getByRole("columnheader", { name: "Screening" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Item total" })).toBeTruthy();
    const draw = within(table).getByRole("row", { name: /Blood draw/ });
    expect(within(draw).getByText("36415 · $25.00")).toBeTruthy();
    expect(within(draw).getByText("Invoice")).toBeTruthy();
    expect(within(draw).getAllByText("$25.00").length).toBeGreaterThan(0);
    expect(within(table).getByText("Inc in PE")).toBeTruthy();
  });

  it("leaves blank cells empty", () => {
    render(<GridTable grid={grid} />);
    const spiro = screen.getByRole("row", { name: /Spirometry/ });
    const cells = within(spiro).getAllByRole("cell");
    expect(cells[1]!.textContent).toBe("");
    expect(cells[2]!.textContent).toBe("");
  });

  it("shows the printed lines, overhead with its percent, and the grand total", () => {
    render(<GridTable grid={grid} />);
    expect(screen.getByRole("row", { name: /Subtotal/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /Overhead \(25%\)/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /Travel stipend/ })).toBeTruthy();
    const total = screen.getByRole("row", { name: /^Total/ });
    expect(within(total).getAllByText("$203.75").length).toBe(2);
  });

  it("reports the row and visit of a clicked item cell, and row -1 for a printed line", () => {
    const onCellClick = vi.fn();
    render(<GridTable grid={grid} onCellClick={onCellClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Spirometry, Screening: $98.00" }));
    expect(onCellClick).toHaveBeenLastCalledWith(1, 0);
    fireEvent.click(screen.getByRole("button", { name: "Overhead (25%), Screening: $30.75" }));
    expect(onCellClick).toHaveBeenLastCalledWith(-1, 0);
    fireEvent.click(screen.getByRole("button", { name: "Blood draw, Week 4: Invoice" }));
    expect(onCellClick).toHaveBeenLastCalledWith(0, 1);
  });

  it("has no buttons when nothing can be clicked, and marks the selected cell", () => {
    const { rerender } = render(<GridTable grid={grid} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    rerender(<GridTable grid={grid} selected={{ row: 0, col: 0 }} onCellClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Blood draw, Screening: $25.00" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Spirometry, Screening: $98.00" }).getAttribute("aria-pressed")).toBe("false");
  });
});
