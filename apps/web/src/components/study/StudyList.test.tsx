import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudyRow } from "@/lib/types";
import { StudyList } from "./StudyList";
import { renderWithClient, stubApi } from "./test-helpers";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

afterEach(() => {
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
  latestVersion: { number: 2, status: "draft" },
  ...over,
});

describe("contracts list", () => {
  it("lists each study with its parties, a status pill and a link to its page", async () => {
    stubApi({
      "GET /studies": () => [
        row({}),
        row({ id: "s2", protocol: "ZRT-9", payer: null, latestVersion: { number: 1, status: "approved" } }),
        row({ id: "s3", protocol: "ABC-1", latestVersion: null }),
      ],
    });
    renderWithClient(<StudyList />);
    const first = (await screen.findByText("NWP-418-02")).closest("a")!;
    expect(first.getAttribute("href")).toBe("/studies/s1");
    expect(first.textContent).toContain("Northwind Pharma · Fieldstone CRO · Discovery Clinical Trials");
    expect(first.textContent).toContain("Questions to answer");
    expect(screen.getByText("ZRT-9").closest("a")!.textContent).toContain("Northwind Pharma · Discovery Clinical Trials");
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Not started")).toBeTruthy();
    expect(screen.getByRole("link", { name: "New contract" }).getAttribute("href")).toBe("/studies/new");
  });

  it("names a study not read yet by its first document and says the details come from the reading", async () => {
    const unread = { protocol: null, sponsorId: null, payerId: null, siteId: null, sponsor: null, payer: null, site: null, latestVersion: null };
    stubApi({ "GET /studies": () => [row({ id: "s4", ...unread }), row({ id: "s5", ...unread, firstDocument: null })] });
    renderWithClient(<StudyList />);
    const first = (await screen.findByText("Master CTA.pdf")).closest("a")!;
    expect(first.textContent).toContain("Study details are filled in when the contract is read");
    expect(first.textContent).toContain("Not started");
    expect(screen.getByText("New contract", { selector: "span" }).closest("a")!.getAttribute("href")).toBe("/studies/s5");
  });

  it("shows a friendly empty state with a way to start", async () => {
    stubApi({ "GET /studies": () => [] });
    renderWithClient(<StudyList />);
    expect(await screen.findByText("No contracts yet")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "New contract" })).toHaveLength(1);
  });

  it("says plainly when the list can't load", async () => {
    stubApi({});
    renderWithClient(<StudyList />);
    expect((await screen.findByRole("alert")).textContent).toContain("Try again");
  });
});
