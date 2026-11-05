import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import type { Party } from "@/lib/types";
import { PartyPicker } from "./PartyPicker";
import { renderWithClient, stubApi } from "./test-helpers";

const party = (id: string, name: string): Party => ({ id, kind: "sponsor", name, aliases: [], createdAt: "2026-11-01T10:00:00Z", createdBy: "Avery Chen" });

beforeEach(() => setActingAs("Avery Chen"));
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

function Harness({ onPick }: { onPick: (p: Party | null) => void }) {
  const [value, setValue] = useState<Party | null>(null);
  return <PartyPicker kind="sponsor" label="Sponsor" value={value} onChange={(p) => { setValue(p); onPick(p); }} />;
}

describe("party picker", () => {
  it("searches as you type and picks a match", async () => {
    const fetch = stubApi({ "GET /parties": (url) => [party("p1", "Northwind Pharma"), party("p9", "Northern Labs")].filter((p) => p.name.toLowerCase().includes((url.searchParams.get("q") ?? "").toLowerCase())) });
    const onPick = vi.fn();
    renderWithClient(<Harness onPick={onPick} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sponsor" }), { target: { value: "northw" } });
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u) === "/api/v1/parties?kind=sponsor&q=northw")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("option", { name: "Northern Labs" })).toBeNull());
    fireEvent.click(await screen.findByRole("option", { name: "Northwind Pharma" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Northwind Pharma");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("offers to add a new sponsor when nothing fits, and uses the one it creates", async () => {
    let created: unknown;
    stubApi({
      "GET /parties": () => [],
      "POST /parties": (_url, init) => {
        created = JSON.parse(init.body as string);
        return party("p7", "Acme Bio");
      },
    });
    const onPick = vi.fn();
    renderWithClient(<Harness onPick={onPick} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Acme Bio" } });
    fireEvent.click(await screen.findByRole("option", { name: "Add 'Acme Bio' as a new sponsor" }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "p7" })));
    expect(created).toEqual({ kind: "sponsor", name: "Acme Bio", by: "Avery Chen" });
  });

  it("doesn't offer to add a name that already exists", async () => {
    stubApi({ "GET /parties": () => [party("p1", "Northwind Pharma")] });
    renderWithClient(<Harness onPick={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "northwind pharma" } });
    await screen.findByRole("option", { name: "Northwind Pharma" });
    expect(screen.queryByRole("option", { name: /Add/ })).toBeNull();
  });

  it("works from the keyboard", async () => {
    stubApi({ "GET /parties": () => [party("p1", "Northwind Pharma")] });
    const onPick = vi.fn();
    renderWithClient(<Harness onPick={onPick} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    await screen.findByRole("option", { name: "Northwind Pharma" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });
});
