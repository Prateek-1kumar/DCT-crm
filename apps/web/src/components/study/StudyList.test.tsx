import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { setActingAs } from "@/lib/acting-as";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudyRow } from "@/lib/types";
import { StudyList } from "./StudyList";
import { renderWithClient, stubApi } from "./test-helpers";

let params = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => params }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

afterEach(() => {
  params = new URLSearchParams();
  cleanup();
  vi.unstubAllGlobals();
});

const row = (over: Partial<StudyRow>): StudyRow => ({
  id: "s1",
  protocol: "NWP-418-02",
  sponsorId: "p1",
  payerId: "p2",
  siteId: "p3",
  createdAt: "2026-11-01T10:00:00Z",
  createdBy: "Avery Chen",
  sponsor: "Northwind Pharma",
  payer: "Fieldstone CRO",
  site: "Discovery Clinical Trials",
  firstDocument: "Master CTA.pdf",
  latestVersion: { id: "v2", number: 2, status: "draft" },
  pi: null,
  updatedAt: "2026-11-01T10:00:00Z",
  liveVersion: null,
  openDecisions: 0,
  newVersionInProgress: false,
  answeredBy: [],
  ...over,
});

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const rows = () => [
  row({ id: "s1", latestVersion: { id: "v2", number: 2, status: "draft" }, openDecisions: 3, pi: "Dr. Priya Raman", updatedAt: ago(5 * 60_000) }),
  row({ id: "s2", protocol: "ZRT-9", payer: null, sponsor: "Zenith Bio", latestVersion: { id: "v1", number: 1, status: "approved" }, liveVersion: 1, updatedAt: ago(26 * 3600_000) }),
  row({ id: "s3", protocol: "ABC-1", latestVersion: { id: "v5", number: 5, status: "failed" }, updatedAt: ago(3 * 86400_000) }),
  row({ id: "s4", protocol: "LIVE-2", latestVersion: { id: "v8", number: 8, status: "reading" }, liveVersion: 7, newVersionInProgress: true, updatedAt: ago(60_000) }),
];

describe("contracts list", () => {
  it("shows each contract with its parties, doctor and site, where it is, its next step and when it changed", async () => {
    stubApi({ "GET /studies": rows });
    renderWithClient(<StudyList />);
    const first = (await screen.findByText("NWP-418-02")).closest("tr")!;
    expect(first.textContent).toContain("Northwind Pharma · Fieldstone CRO");
    expect(first.textContent).toContain("Discovery Clinical Trials · Dr. Priya Raman");
    expect(first.textContent).toContain("3 decisions to make");
    expect(first.textContent).toContain("5 min ago");
    expect(within(first).getByRole("link", { name: "NWP-418-02" }).getAttribute("href")).toBe("/studies/s1");
    expect(within(first).getByRole("link", { name: "Answer 3 decisions" }).getAttribute("href")).toBe("/versions/v2/questions");
    const live = screen.getByText("ZRT-9").closest("tr")!;
    expect(live.textContent).toContain("Live · version 1");
    expect(live.textContent).toContain("Yesterday");
    expect(within(live).getByRole("link", { name: "Open rulebook" }).getAttribute("href")).toBe("/versions/v1");
    expect(screen.getByRole("link", { name: "Add contract" }).getAttribute("href")).toBe("/studies/new");
  });

  it("tags a live contract whose next version is in progress", async () => {
    stubApi({ "GET /studies": rows });
    renderWithClient(<StudyList />);
    expect((await screen.findByText("LIVE-2")).closest("tr")!.textContent).toContain("New version in progress");
    expect(screen.getByText("NWP-418-02").closest("tr")!.textContent).not.toContain("New version in progress");
  });

  it("shows counts on the filter pills and filters by the one in the address", async () => {
    stubApi({ "GET /studies": rows });
    params = new URLSearchParams("filter=needs-you");
    renderWithClient(<StudyList />);
    await screen.findByText("NWP-418-02");
    expect(screen.getByRole("link", { name: /^All\s*4$/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Needs you\s*1/ }).getAttribute("href")).toBe("/?filter=needs-you");
    expect(screen.getByRole("link", { name: /Live\s*2/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Couldn't read\s*1/ })).toBeTruthy();
    expect(screen.queryByText("ZRT-9")).toBeNull();
  });

  it("says plainly when a filter has nothing in it", async () => {
    stubApi({ "GET /studies": () => [rows()[1]!] });
    params = new URLSearchParams("filter=failed");
    renderWithClient(<StudyList />);
    expect(await screen.findByText("No contract failed to read.")).toBeTruthy();
  });

  it("searches protocol, sponsor, site and doctor", async () => {
    stubApi({ "GET /studies": rows });
    renderWithClient(<StudyList />);
    await screen.findByText("NWP-418-02");
    const box = screen.getByRole("searchbox", { name: "Search contracts" });
    fireEvent.change(box, { target: { value: "raman" } });
    expect(screen.getByText("NWP-418-02")).toBeTruthy();
    expect(screen.queryByText("ZRT-9")).toBeNull();
    fireEvent.change(box, { target: { value: "zenith" } });
    expect(screen.getByText("ZRT-9")).toBeTruthy();
    fireEvent.change(box, { target: { value: "nothing like this" } });
    expect(screen.getByText(/No contract matches/)).toBeTruthy();
  });

  it("names a contract not read yet by its first document and offers the next step", async () => {
    const unread = { protocol: null, sponsorId: null, payerId: null, siteId: null, sponsor: null, payer: null, site: null, latestVersion: null };
    stubApi({ "GET /studies": () => [row({ id: "s4", ...unread }), row({ id: "s5", ...unread, firstDocument: null })] });
    renderWithClient(<StudyList />);
    const first = (await screen.findByText("Master CTA.pdf")).closest("tr")!;
    expect(first.textContent).toContain("Study details are filled in when the contract is read");
    expect(within(first).getByRole("link", { name: "Start reading" })).toBeTruthy();
    const none = screen.getByText("New contract").closest("tr")!;
    expect(within(none).getByRole("link", { name: "Add files" }).getAttribute("href")).toBe("/studies/s5?tab=documents");
  });

  it("disables the approve button for the person who answered, saying who did", async () => {
    setActingAs("Avery Chen");
    stubApi({ "GET /studies": () => [row({ answeredBy: ["Avery Chen"] })] });
    renderWithClient(<StudyList />);
    const button = (await screen.findByRole("button", { name: /Waiting for a colleague/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-label")).toContain("Avery Chen answered");
    setActingAs(null);
  });

  it("shows a friendly empty state with a way to start", async () => {
    stubApi({ "GET /studies": () => [] });
    renderWithClient(<StudyList />);
    expect(await screen.findByText("No contracts yet")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Add contract" })).toHaveLength(2);
  });

  it("shows a skeleton while loading", () => {
    stubApi({ "GET /studies": () => new Promise(() => {}) });
    renderWithClient(<StudyList />);
    expect(screen.getByLabelText("Loading your contracts")).toBeTruthy();
  });

  it("says plainly when the list can't load", async () => {
    stubApi({});
    renderWithClient(<StudyList />);
    expect((await screen.findByRole("alert")).textContent).toContain("Try again");
  });
});
