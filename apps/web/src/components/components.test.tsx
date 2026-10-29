import type { DiffEntry } from "@dct/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { DiffView } from "./DiffView";
import { errorText } from "./ui";

afterEach(cleanup);

describe("DiffView", () => {
  const entries: DiffEntry[] = [
    { path: "/payment/netDays/value", change: "changed", before: 45, after: 30, label: "Payment › Net days" },
    { path: "/invoiceables/5", change: "added", before: null, after: { name: "Remote monitoring visit", amountCents: 42000 }, label: "Invoiceable › Remote monitoring visit" },
    { path: "/siteFees/3", change: "removed", before: { name: "Annual maintenance", amountCents: 200000 }, after: null, label: "Site fee › Annual maintenance" },
    { path: "/budgetGrids/0/procedures/3/cells/V2", change: "changed", before: 9800, after: 11200, label: "Budget grid › Exhibit A › Spirometry › V2" },
  ];

  it("groups by section with counts and readable money", () => {
    render(<DiffView entries={entries} />);
    expect(screen.getByText("2 changed")).toBeTruthy();
    expect(screen.getByText("1 added")).toBeTruthy();
    expect(screen.getByText("1 removed")).toBeTruthy();
    const grid = screen.getByRole("heading", { name: /Budget grid/ }).closest("section")!;
    expect(within(grid).getByText("Exhibit A › Spirometry › V2")).toBeTruthy();
    expect(grid.querySelector("del")!.textContent).toBe("was $98.00");
    expect(grid.querySelector("ins")!.textContent).toBe("now $112.00");
    expect(screen.getByText(/Remote monitoring visit · \$420.00/)).toBeTruthy();
    const removed = screen.getByRole("heading", { name: /Site fee/ }).closest("section")!;
    expect(removed.querySelector("ins")).toBeNull();
  });

  it("has an empty state", () => {
    render(<DiffView entries={[]} />);
    expect(screen.getByText("No differences")).toBeTruthy();
  });
});

describe("errorText", () => {
  it("shows people's messages and hides everything technical", () => {
    expect(errorText(new ApiError(409, "2 questions still need an answer before this can be approved."))).toBe("2 questions still need an answer before this can be approved.");
    expect(errorText(new ApiError(500, "Something went wrong on the server. Try again; if it keeps happening, tell the team (ref r-1)."))).toMatch(/ref r-1/);
    expect(errorText(new ApiError(502, "Internal Server Error"))).toMatch(/^Something went wrong on the server/);
    expect(errorText(new ApiError(0, "Can't reach the API. Is it running on port 4100?"))).toMatch(/^Can't reach DCT Finance/);
    expect(errorText(new ApiError(404, "Study not found"))).toMatch(/^We couldn't find this/);
    expect(errorText(new ApiError(400, "✖ Invalid input: expected string\n  → at by"))).toMatch(/^That didn't go through/);
    expect(errorText(new TypeError("Cannot read properties of undefined (reading 'x')"))).toMatch(/^Something went wrong on this page/);
  });
});
