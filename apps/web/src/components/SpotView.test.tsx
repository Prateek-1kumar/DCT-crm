import type { DocumentDto } from "@dct/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { RowCompare } from "./RowCompare";
import { SpotView } from "./SpotView";

const doc = { id: "d1", filename: "Work order.pdf", kind: "work_order", pageCount: 4 } as DocumentDto;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  // jsdom has no <dialog> methods and no layout: stand in for both, with a size so the close-ups draw.
  Object.assign(HTMLDialogElement.prototype, { showModal() {}, close() {} });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ contentRect: { width: 600, height: 400 }, target: el } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
  vi.spyOn(api, "pageSrc").mockResolvedValue("/api/v1/documents/d1/pages/2.png?dpi=300");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("page close-ups", () => {
  it("say so when the page image can't be drawn, instead of a broken image", async () => {
    wrap(<SpotView documents={[doc]} spot={{ documentId: "d1", page: 2, box: [0.5, 0.4, 0.1, 0.02] }} zoom={2} onZoom={() => {}} />);
    fireEvent.error(await screen.findByAltText("Page 2"));
    expect(screen.getByRole("alert").textContent).toMatch(/This page image isn't available/);
    expect(screen.queryByAltText("Page 2")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open the whole page" })).toBeNull();
  });

  it("in the row comparison too, keeping our numbers in view", async () => {
    const unit = { id: "u", section: "rows", title: "Blood draw", sub: "", doc: "d1", page: 2, money: 0, cells: [{ path: "/budgetGrids/0/procedures/0/unitCents", label: "Unit", value: 5500, box: [0.6, 0.4, 0.08, 0.02] }] } as const;
    wrap(<RowCompare unit={{ ...unit, cells: [...unit.cells] } as never} selecting={false} selected={new Set()} onToggle={() => {}} />);
    fireEvent.error(await screen.findByAltText("Page 2, Blood draw"));
    expect(screen.getByRole("alert").textContent).toMatch(/This page image isn't available/);
    expect(screen.getByText("$55.00")).toBeTruthy();
  });
});
