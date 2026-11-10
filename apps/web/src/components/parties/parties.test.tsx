import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import type { Party, PartyKind, PartyRow } from "@/lib/types";
import { renderWithClient, stubApi, stubDialog, study } from "../study/test-helpers";
import { ContractParties } from "./ContractParties";
import { PartySettings } from "./PartySettings";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

beforeEach(() => {
  stubDialog();
  setActingAs("Sam Rivera");
});
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

const row = (id: string, kind: PartyKind, name: string, studies = 1, aliases: string[] = []): PartyRow => ({ id, kind, name, aliases, studies, createdAt: "2026-11-01T10:00:00Z", createdBy: "Avery Chen" });

const PARTIES = [
  row("p1", "sponsor", "Northwind Pharma", 2, ["Northwind", "NW Pharma Inc.", "Northwind Pharmaceuticals", "Northwind Ltd"]),
  row("p9", "sponsor", "Northwind Pharma Inc", 1),
  row("p2", "cro", "Fieldstone CRO", 3),
  row("p3", "site", "Discovery Clinical Trials", 1),
];

const body = (init: RequestInit) => JSON.parse(init.body as string) as Record<string, unknown>;
const json = (status: number, message: string) => new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json" } });

describe("settings: parties", () => {
  it("groups parties under Sponsors, CROs and Sites with counts and contract numbers", async () => {
    stubApi({ "GET /parties": () => PARTIES });
    renderWithClient(<PartySettings />);
    const sponsors = (await screen.findByRole("heading", { level: 3, name: /Sponsors/ })).closest("section")!;
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: /Sponsors/ }).textContent).toContain("2");
    expect(screen.getByRole("heading", { level: 3, name: /CROs/ }).textContent).toContain("1");
    expect(screen.getByRole("heading", { level: 3, name: /Sites/ }).textContent).toContain("1");
    expect(within(sponsors).getByText("2 contracts")).toBeTruthy();
    expect(screen.getAllByText("1 contract")).toHaveLength(2);
  });

  it("shows three other names and folds the rest into +N", async () => {
    stubApi({ "GET /parties": () => PARTIES });
    renderWithClient(<PartySettings />);
    await screen.findByText("Northwind Pharma");
    expect(screen.getByText("Northwind Pharmaceuticals")).toBeTruthy();
    expect(screen.queryByText("Northwind Ltd")).toBeNull();
    fireEvent.click(screen.getByText("+1"));
    expect(screen.getByText("Northwind Ltd")).toBeTruthy();
    fireEvent.click(screen.getByText("Show fewer"));
    expect(screen.queryByText("Northwind Ltd")).toBeNull();
  });

  it("searches names and other names across every group", async () => {
    stubApi({ "GET /parties": () => PARTIES });
    renderWithClient(<PartySettings />);
    await screen.findByText("Fieldstone CRO");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search names" }), { target: { value: "ltd" } });
    expect(screen.getByText("Northwind Pharma")).toBeTruthy();
    expect(screen.queryByText("Fieldstone CRO")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search names" }), { target: { value: "zzz" } });
    expect(screen.getByText("No name matches “zzz”.")).toBeTruthy();
  });

  it("renames, telling how many contracts change, and announces the result", async () => {
    let sent: Record<string, unknown> = {};
    stubApi({
      "GET /parties": () => PARTIES,
      "PATCH /parties/p2": (_u, init) => {
        sent = body(init);
        return { id: "p2", kind: "cro", name: "Fieldstone Research", aliases: [], createdAt: "", createdBy: "" } satisfies Party;
      },
    });
    renderWithClient(<PartySettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Fieldstone CRO" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("3 contracts");
    expect(dialog.textContent).toContain("is kept as another name");
    const input = within(dialog).getByLabelText("New name");
    expect((within(dialog).getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  Fieldstone Research " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Renamed “Fieldstone CRO” to “Fieldstone Research”."));
    expect(sent).toEqual({ name: "Fieldstone Research", by: "Sam Rivera" });
    expect(screen.queryByLabelText("New name")).toBeNull();
  });

  it("shows the name-already-exists message as the server wrote it", async () => {
    const message = "A sponsor called Northwind Pharma already exists. Merge them instead.";
    stubApi({ "GET /parties": () => PARTIES, "PATCH /parties/p9": () => json(409, message) });
    renderWithClient(<PartySettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Northwind Pharma Inc" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "Northwind Pharma" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Rename" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("merges only into another party of the same kind, after naming it on the confirm button", async () => {
    let sent: Record<string, unknown> = {};
    stubApi({
      "GET /parties": () => PARTIES,
      "POST /parties/p9/merge": (_u, init) => {
        sent = body(init);
        return PARTIES[0];
      },
    });
    renderWithClient(<PartySettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Merge into… (Northwind Pharma Inc)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByLabelText(/Fieldstone/)).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: /Northwind Pharma Inc/ })).toBeNull();
    expect((within(dialog).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Northwind Pharma/ }));
    expect(dialog.textContent).toContain("Its 1 contract moves to Northwind Pharma. Its names become other names for Northwind Pharma. This can't be undone.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge into Northwind Pharma" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Merged “Northwind Pharma Inc” into “Northwind Pharma”."));
    expect(sent).toEqual({ into: "p1", by: "Sam Rivera" });
  });

  it("says so when a party has nothing to merge into", async () => {
    stubApi({ "GET /parties": () => PARTIES });
    renderWithClient(<PartySettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Merge into… (Fieldstone CRO)" }));
    expect(screen.getByRole("dialog").textContent).toContain("There is no other CRO");
  });

  it("asks who is working before opening a dialog", async () => {
    setActingAs(null);
    stubApi({ "GET /parties": () => PARTIES });
    renderWithClient(<PartySettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Fieldstone CRO" }));
    expect(screen.queryByLabelText("New name")).toBeNull();
  });

  it("explains an empty list and a failed load", async () => {
    stubApi({ "GET /parties": () => [] });
    renderWithClient(<PartySettings />);
    expect(await screen.findByText("No names yet")).toBeTruthy();
    cleanup();
    stubApi({ "GET /parties": () => json(500, "Something went wrong on the server.") });
    renderWithClient(<PartySettings />);
    expect(await screen.findByRole("heading", { name: "The list of names didn't load" })).toBeTruthy();
  });
});

describe("ContractParties", () => {
  it("shows each linked party and Not set for a missing one", () => {
    renderWithClient(<ContractParties study={study({ payer: null })} />);
    expect(screen.getByText("Northwind Pharma").getAttribute("title")).toBe("Northwind Pharma");
    expect(screen.getByText("Discovery Clinical Trials")).toBeTruthy();
    expect(screen.getByText("Not set")).toBeTruthy();
  });

  it("chooses another party of that kind and puts the returned contract in the cache", async () => {
    let sent: Record<string, unknown> = {};
    const updated = study({ sponsor: PARTIES[1] });
    stubApi({
      "GET /parties": () => PARTIES,
      "PATCH /studies/s1/parties": (_u, init) => {
        sent = body(init);
        return updated;
      },
    });
    renderWithClient(<ContractParties study={study()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Sponsor" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("This only changes this contract. To fix a name everywhere, rename it in Settings");
    expect(within(dialog).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    await within(dialog).findByRole("radio", { name: /Northwind Pharma Inc/ });
    expect(within(dialog).queryByRole("radio", { name: /Fieldstone/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Northwind Pharma Inc/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: false })?.hasAttribute("open") ?? false).toBe(false));
    expect(sent).toEqual({ sponsorId: "p9", by: "Sam Rivera" });
  });

  it("clears a party with Not set", async () => {
    let sent: Record<string, unknown> = {};
    stubApi({
      "GET /parties": () => PARTIES,
      "PATCH /studies/s1/parties": (_u, init) => {
        sent = body(init);
        return study({ site: null });
      },
    });
    renderWithClient(<ContractParties study={study()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Site" }));
    const dialog = screen.getByRole("dialog");
    const notSet = await within(dialog).findByRole("radio", { name: "Not set" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(notSet);
    fireEvent.click(save);
    await waitFor(() => expect(sent).toEqual({ siteId: null, by: "Sam Rivera" }));
  });
});
