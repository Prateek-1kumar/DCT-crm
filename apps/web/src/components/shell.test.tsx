import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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

beforeEach(stubDialog);
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
});
