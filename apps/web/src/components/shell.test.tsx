import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { renderWithClient, stubApi, stubDialog } from "./study/test-helpers";
import type { StudyRow } from "@/lib/types";

const push = vi.fn();
let path = "/";
vi.mock("next/navigation", () => ({ usePathname: () => path, useSearchParams: () => new URLSearchParams("filter=live"), useRouter: () => ({ push }) }));
// next/image and next/link need the Next runtime; plain elements are enough for what is asserted here.
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

beforeEach(() => {
  stubDialog();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  push.mockReset();
  path = "/";
  vi.unstubAllGlobals();
});

const row = (over: Partial<StudyRow>): StudyRow => ({
  id: "s1", protocol: "NWP-418-02", sponsorId: null, payerId: null, siteId: null, createdAt: "2026-11-01T10:00:00Z", createdBy: "A", sponsor: "Northwind Pharma", payer: null, site: "Mercy Clinic",
  firstDocument: "a.pdf", latestVersion: { id: "v1", number: 1, status: "draft" }, pi: "Dr. Raman", updatedAt: "2026-11-01T10:00:00Z", liveVersion: null, openDecisions: 2, newVersionInProgress: false, answeredBy: [], ...over,
});
const rows = () => [row({}), row({ id: "s2", protocol: "ZRT-9", sponsor: "Zenith", pi: null, openDecisions: 0 }), row({ id: "s3", protocol: "LV-1", latestVersion: { id: "v3", number: 3, status: "approved" }, liveVersion: 3 })];

describe("shell", () => {
  it("shows the logo, Contracts with its four filters and counts, How it works and the name picker", async () => {
    stubApi({ "GET /studies": rows });
    renderWithClient(<Sidebar />);
    expect(screen.getAllByRole("img", { name: "Discovery Clinical Trials" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Contracts" })[0]!.getAttribute("href")).toBe("/");
    expect(await screen.findByRole("link", { name: /Needs you\s*1/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Waiting for approval\s*1/ }).getAttribute("href")).toBe("/?filter=waiting");
    expect(screen.getByRole("link", { name: /Live\s*1/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Couldn't read\s*0/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "How it works" }).getAttribute("href")).toBe("/how-it-works");
    expect(screen.getByText("Choose your name")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Activity" }).getAttribute("href")).toBe("/activity");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
  });

  it("Activity and Settings are marked when you are on them, and Contracts is not", async () => {
    stubApi({ "GET /studies": rows });
    path = "/activity";
    const { unmount } = renderWithClient(<Sidebar />);
    expect(screen.getByRole("link", { name: "Activity" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getAllByRole("link", { name: "Contracts" })[0]!.getAttribute("aria-current")).toBeNull();
    unmount();
    path = "/settings";
    renderWithClient(<Sidebar />);
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  });

  it("the bell counts the contracts that need you and opens that list", async () => {
    stubApi({ "GET /studies": rows });
    renderWithClient(<Sidebar />);
    const bell = await screen.findByRole("link", { name: "1 contract needs you" });
    expect(bell.getAttribute("href")).toBe("/?filter=needs-you");
  });

  it("⌘K opens a search over protocol, sponsor, site and doctor, and opens the match", async () => {
    stubApi({ "GET /studies": rows });
    renderWithClient(<Sidebar />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const box = await screen.findByRole("textbox", { name: "Search contracts" });
    await screen.findByText("ZRT-9");
    fireEvent.change(box, { target: { value: "raman" } });
    expect(screen.queryByText("ZRT-9")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /NWP-418-02/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/studies/s1"));
  });

  describe("collapsing", () => {
    const toggle = (name: RegExp | string) => screen.getByRole("button", { name });

    it("starts expanded on ordinary screens and collapsed on contract screens", () => {
      stubApi({ "GET /studies": rows });
      const { unmount } = renderWithClient(<Sidebar />);
      expect(toggle("Collapse the sidebar").getAttribute("aria-expanded")).toBe("true");
      unmount();
      path = "/versions/v1/proof";
      renderWithClient(<Sidebar />);
      expect(toggle("Expand the sidebar").getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("link", { name: /Needs you/ })).toBeNull();
    });

    it("the rail names every icon and shows the counts", async () => {
      stubApi({ "GET /studies": rows });
      path = "/versions/v1/questions";
      renderWithClient(<Sidebar />);
      expect(await screen.findByRole("link", { name: "Contracts, 1 needs you" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "1 contract needs you" }).getAttribute("href")).toBe("/?filter=needs-you");
      expect(screen.getAllByText("1").length).toBe(2); // the badge on the bell and on Contracts
      for (const [name, href] of [["Activity", "/activity"], ["How it works", "/how-it-works"], ["Settings", "/settings"]] as const) {
        const link = screen.getByRole("link", { name });
        expect(link.getAttribute("href")).toBe(href);
        expect(link.getAttribute("title")).toBe(name);
      }
      expect(toggle("Search").getAttribute("title")).toBe("Search (⌘K)");
      expect(toggle("Choose your name").textContent).toBe("?");
      fireEvent.click(toggle("Search"));
      expect(await screen.findByRole("textbox", { name: "Search contracts" })).toBeTruthy();
    });

    it("the avatar shows the person's initials", () => {
      localStorage.setItem("dct.actingAs", "Avery Chen");
      stubApi({ "GET /studies": rows });
      path = "/versions/v1/proof";
      renderWithClient(<Sidebar />);
      expect(toggle(/Avery Chen, working now/).textContent).toBe("AC");
    });

    it("collapsing on an ordinary screen is remembered for the other ordinary screens, not for contract screens", () => {
      stubApi({ "GET /studies": rows });
      const { unmount } = renderWithClient(<Sidebar />);
      fireEvent.click(toggle("Collapse the sidebar"));
      expect(toggle("Expand the sidebar")).toBeTruthy();
      unmount();
      path = "/activity";
      renderWithClient(<Sidebar />);
      expect(toggle("Expand the sidebar")).toBeTruthy();
    });

    it("expanding on a contract screen is remembered for contract screens only", () => {
      stubApi({ "GET /studies": rows });
      path = "/versions/v1/proof";
      const { unmount } = renderWithClient(<Sidebar />);
      fireEvent.click(toggle("Expand the sidebar"));
      expect(toggle("Collapse the sidebar")).toBeTruthy();
      unmount();
      path = "/versions/v2/questions";
      const second = renderWithClient(<Sidebar />);
      expect(toggle("Collapse the sidebar")).toBeTruthy();
      second.unmount();
      path = "/";
      renderWithClient(<Sidebar />);
      expect(toggle("Collapse the sidebar")).toBeTruthy(); // the other kind is untouched: still its default, expanded
    });

    it("navigating between kinds applies each kind's own preference", () => {
      stubApi({ "GET /studies": rows });
      const client = new QueryClient();
      const { rerender } = render(<QueryClientProvider client={client}><Sidebar /></QueryClientProvider>);
      expect(toggle("Collapse the sidebar")).toBeTruthy();
      path = "/versions/v1/proof";
      rerender(<QueryClientProvider client={client}><Sidebar /></QueryClientProvider>);
      expect(toggle("Expand the sidebar")).toBeTruthy();
    });
  });
});
