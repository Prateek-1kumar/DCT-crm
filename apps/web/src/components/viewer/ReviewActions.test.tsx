import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs, usePersonPrompt } from "@/lib/acting-as";
import { keys } from "@/lib/queries";
import type { Version } from "@/lib/types";
import { mockApi, posts, renderWithClient, version } from "../version/fixtures";
import { ReviewActions } from "./ReviewActions";
import { markSummary, noteProblem } from "./reviewState";

afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});
beforeEach(() => setActingAs(null));

const at = "2026-11-03T10:00:00Z";
const mark = (item: string, by: string) => ({ item, by, at });

/** A fake API that applies each write to a copy of the version, like the real one. */
function api(start: Version) {
  let v = start;
  const fetch = mockApi({
    "POST /versions/v1/proofread": (b) => {
      const { by, items } = b as { by: string; items: string[] };
      v = { ...v, proofreads: [...v.proofreads, ...items.filter((i) => !v.proofreads.some((p) => p.item === i && p.by === by)).map((i) => mark(i, by))] };
      return v;
    },
    "DELETE /versions/v1/proofread": () => ((v = { ...v, proofreads: [] }), v),
    "POST /versions/v1/flag": (b) => {
      const { by, item, note } = b as { by: string; item: string; note: string };
      v = { ...v, flags: [...v.flags.filter((f) => !(f.item === item && f.by === by)), { item, by, note, at }] };
      return v;
    },
    "DELETE /versions/v1/flag": () => ((v = { ...v, flags: [] }), v),
  });
  return fetch;
}

const open = (v: Version, items: string[], me: string | null, onChange?: (v: Version) => void) => renderWithClient(<ReviewActions version={v} items={items} me={me} onChange={onChange} />);

describe("ReviewActions", () => {
  it("says nothing was proofread, and marks the item for me", async () => {
    const v = version();
    const fetch = api(v);
    const onChange = vi.fn();
    open(v, ["t1"], "Ana", onChange);
    expect(screen.getByText("Not proofread yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Matches the contract" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Ana", items: ["t1"] });
    expect(onChange.mock.calls[0]![0].proofreads).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("Marked as matching the contract");
  });

  it("writes the returned version into the cache under the version's key", async () => {
    const v = version();
    api(v);
    const client = new QueryClient({ defaultOptions: { mutations: { networkMode: "always" } } });
    render(
      <QueryClientProvider client={client}>
        <ReviewActions version={v} items={["t1"]} me="Ana" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Matches the contract" }));
    await waitFor(() => expect((client.getQueryData(keys.version("v1")) as Version).proofreads).toHaveLength(1));
  });

  it("with my mark already there, offers to remove it; others' marks are listed", async () => {
    const v = version({ proofreads: [mark("t1", "Ana"), mark("t1", "Ben")] });
    const fetch = api(v);
    open(v, ["t1"], "Ana");
    expect(screen.getByText("Proofread by Ana, Ben")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove my mark" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Your mark is removed"));
    expect(fetch.mock.calls.some(([u, i]) => i?.method === "DELETE" && String(u).includes("by=Ana") && String(u).includes("item=t1"))).toBe(true);
  });

  it("with several items marks only the ones I haven't, and counts them", async () => {
    const v = version({ proofreads: [mark("a", "Ben"), mark("b", "Ana")] });
    const fetch = api(v);
    open(v, ["a", "b", "c"], "Ana");
    expect(screen.getByText("2 of 3 proofread by Ben, Ana")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Matches the contract" }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string).items).toEqual(["a", "c"]);
  });

  it("asks who is working instead of sending when no name is chosen", () => {
    function Probe() {
      return <span>{usePersonPrompt() ? "asked" : "not asked"}</span>;
    }
    const v = version();
    const fetch = api(v);
    renderWithClient(
      <>
        <Probe />
        <ReviewActions version={v} items={["t1"]} me={null} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Matches the contract" }));
    expect(screen.getByText("asked")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("'Something looks wrong' opens a note; an empty or too long note is refused in plain words", async () => {
    const v = version();
    const fetch = api(v);
    open(v, ["t1"], "Ana");
    fireEvent.click(screen.getByRole("button", { name: "Something looks wrong" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("Say what looks wrong");
    fireEvent.change(screen.getByLabelText("What looks wrong?"), { target: { value: "x".repeat(501) } });
    expect(screen.getByRole("alert").textContent).toContain("too long");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves the note, shows the flag with who and what, and lets me remove my own", async () => {
    const v = version({ flags: [{ item: "t1", by: "Ben", note: "Amount is for two visits", at }] });
    const fetch = api(v);
    const onChange = vi.fn();
    open(v, ["t1"], "Ana", onChange);
    // Ben's flag has no remove button for Ana
    expect(screen.getByText(/Ben says something looks wrong/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove my flag" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Something looks wrong" }));
    fireEvent.change(screen.getByLabelText("What looks wrong?"), { target: { value: "  The cap is missing  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(JSON.parse(posts(fetch)[0]![1]!.body as string)).toEqual({ by: "Ana", item: "t1", note: "The cap is missing" });
    expect(screen.queryByLabelText("What looks wrong?")).toBeNull();
  });

  it("shows my flag with 'Remove my flag'", async () => {
    const v = version({ flags: [{ item: "t1", by: "Ana", note: "Check this", at }] });
    const fetch = api(v);
    const onChange = vi.fn();
    open(v, ["t1"], "Ana", onChange);
    fireEvent.click(screen.getByRole("button", { name: "Remove my flag" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(fetch.mock.calls.some(([u, i]) => i?.method === "DELETE" && String(u).includes("/flag"))).toBe(true);
  });

  it("Cancel closes the note without sending", () => {
    const v = version();
    const fetch = api(v);
    open(v, ["t1"], "Ana");
    fireEvent.click(screen.getByRole("button", { name: "Something looks wrong" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("What looks wrong?")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says in plain words when it failed, and keeps the buttons usable", async () => {
    const v = version();
    mockApi({ "POST /versions/v1/proofread": () => new Response(JSON.stringify({ message: "This version is being read right now." }), { status: 409 }) });
    open(v, ["t1"], "Ana");
    fireEvent.click(screen.getByRole("button", { name: "Matches the contract" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("being read"));
    expect((screen.getByRole("button", { name: "Matches the contract" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("with nothing to proofread says so (compact: nothing)", () => {
    const v = version();
    const { container } = open(v, [], "Ana");
    expect(container.textContent).toContain("nothing here to proofread");
    cleanup();
    const again = renderWithClient(<ReviewActions version={v} items={[]} me="Ana" compact />);
    expect(again.container.textContent).toBe("");
  });
});

describe("review text", () => {
  it("summarises marks", () => {
    expect(markSummary([], 0, 1)).toBe("Not proofread yet");
    expect(markSummary(["Ana"], 1, 1)).toBe("Proofread by Ana");
    expect(markSummary(["Ana", "Ben"], 3, 8)).toBe("3 of 8 proofread by Ana, Ben");
  });
  it("checks notes", () => {
    expect(noteProblem("")).not.toBeNull();
    expect(noteProblem("   ")).not.toBeNull();
    expect(noteProblem("ok")).toBeNull();
    expect(noteProblem("x".repeat(500))).toBeNull();
    expect(noteProblem("x".repeat(501))).toContain("501");
  });
});
