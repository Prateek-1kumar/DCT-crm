import { useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { mockApi, posts, renderWithClient } from "../version/fixtures";
import type { ShowRef } from "../rulebook";
import { ContractSidePanel } from "./ContractSidePanel";
import { coverage, sampleVersion } from "./test-data";

vi.mock("@/components/PageView", async (original) => ({
  ...(await original<object>()),
  PageView: ({ boxes = [], alt }: { boxes?: { label: string; mark: string; onClick?: () => void }[]; alt: string }) => (
    <div role="group" aria-label={alt}>
      {boxes.map((b, i) => (
        <button key={i} type="button" aria-label={b.label} data-mark={b.mark} onClick={b.onClick} />
      ))}
    </div>
  ),
}));

// The panel is handed a version by its parent; this host re-reads it from the cache like the workspace does.
function Host({ target, onClose = () => {}, onOpenFull = () => {} }: { target: ShowRef | null; onClose?: () => void; onOpenFull?: () => void }) {
  const v = useQuery({ queryKey: keys.version("v1"), queryFn: () => api.version("v1") });
  return v.data ? <ContractSidePanel version={v.data} target={target} onClose={onClose} onOpenFull={onOpenFull} /> : null;
}

const mark = (item: string, by: string) => ({ item, by, at: "2026-11-03T10:00:00Z" });

function setup(target: ShowRef | null, over: { proofreads?: ReturnType<typeof mark>[]; coverage?: () => unknown; onClose?: () => void; onOpenFull?: () => void } = {}) {
  let current = sampleVersion({ proofreads: over.proofreads ?? [] });
  const fetch = mockApi({
    "GET /versions/v1": () => current,
    "GET /versions/v1/coverage": over.coverage ?? coverage,
    "GET /documents/d1/pages/1/find": () => ({ boxes: [[0.1, 0.5, 0.6, 0.55]] }),
    "POST /versions/v1/proofread": (body) => {
      const { by, items } = body as { by: string; items: string[] };
      current = { ...current, proofreads: [...current.proofreads, ...items.map((i) => mark(i, by))] };
      return current;
    },
    "DELETE /versions/v1/proofread": () => {
      current = { ...current, proofreads: [] };
      return current;
    },
  });
  renderWithClient(<Host target={target} onClose={over.onClose} onOpenFull={over.onOpenFull} />);
  return fetch;
}

beforeEach(() => setActingAs(null));
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

describe("ContractSidePanel", () => {
  it("shows nothing without a target", () => {
    setup(null);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows a term: its name, proof, quote, the page, and the quote highlighted", async () => {
    setup({ target: "term", id: "t1" });
    expect(await screen.findByRole("heading", { name: "Startup fee" })).toBeTruthy();
    expect(screen.getByText("Matches the contract")).toBeTruthy();
    expect(screen.getByText("Startup fee $5,000")).toBeTruthy();
    expect(screen.getByText("Contract.pdf, page 1")).toBeTruthy();
    expect(screen.getByText("Not proofread yet")).toBeTruthy();
    expect((await screen.findByRole("button", { name: "The words quoted in the rulebook" })).dataset.mark).toBe("highlight");
    expect(screen.getByRole("group", { name: "Contract.pdf, page 1" })).toBeTruthy();
  });

  it("jumps to a grid's page for a grid cell and highlights the cell's amount", async () => {
    setup({ target: "grid", id: "g1", row: 0, col: 0 });
    expect(await screen.findByRole("heading", { name: "Blood draw, Screening" })).toBeTruthy();
    expect(await screen.findByRole("group", { name: "Contract.pdf, page 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^\$25\.00/ }).dataset.mark).toBe("highlight");
  });

  it("opens a whole grid (row -1) on its first page", async () => {
    setup({ target: "grid", id: "g1", row: -1, col: 0 });
    expect(await screen.findByRole("heading", { name: "Visit budget" })).toBeTruthy();
    expect(screen.getByText("Mark all proofread", { selector: "button" })).toBeTruthy();
  });

  it("shows who proofread it and marks / unmarks as the chosen person, updating the cached version", async () => {
    setActingAs("Ana");
    const fetch = setup({ target: "term", id: "t1" }, { proofreads: [mark("t1", "Ben")] });
    expect(await screen.findByText("Proofread by Ben")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark as proofread: Startup fee" }));
    expect(await screen.findByText("Proofread by Ben, Ana")).toBeTruthy();
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Ana", items: ["t1"] });
    fireEvent.click(screen.getByRole("button", { name: "Remove my proofread mark from Startup fee" }));
    expect(await screen.findByText("Not proofread yet")).toBeTruthy();
  });

  it("asks who is working instead of sending when no name is chosen", async () => {
    const fetch = setup({ target: "term", id: "t1" });
    fireEvent.click(await screen.findByRole("button", { name: "Mark as proofread: Startup fee" }));
    expect(posts(fetch)).toHaveLength(0);
  });

  it("Open full view and Close call back; Escape closes too", async () => {
    const onOpenFull = vi.fn();
    const onClose = vi.fn();
    setup({ target: "term", id: "t1" }, { onOpenFull, onClose });
    fireEvent.click(await screen.findByRole("button", { name: "Open full view" }));
    expect(onOpenFull).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close the contract panel" }));
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("says the spot isn't on a page we have when the line's document is missing", async () => {
    setup({ target: "grid", id: "gone", row: 0, col: 0 });
    expect(await screen.findByText("This line is no longer in the rulebook.")).toBeTruthy();
    expect(screen.getByText(/This spot isn't on the page we have/)).toBeTruthy();
  });

  it("shows a skeleton while the pages load, then a plain error with a retry when they can't", async () => {
    setup({ target: "term", id: "t1" }, { coverage: () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }) });
    expect(await screen.findByLabelText("Loading the contract page")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Something went wrong on the server/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
