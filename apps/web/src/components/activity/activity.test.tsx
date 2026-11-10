import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem, ActivityPage } from "@/lib/types";
import { renderWithClient, stubApi } from "../study/test-helpers";
import { dayLabel, groupByDay } from "./days";
import { ActivityFeed, HistoryTab } from "./index";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Local-time constructors: the grouping is by the viewer's calendar day, whatever zone the test runs in.
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const item = (id: number, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id, at: at(2026, 11, 7, 9), by: "Ana Answerer", summary: `Entry ${id}`, kind: "decision", studyId: "s1", studyTitle: "NWP-418-02", versionNumber: 1, ...over,
});

describe("day grouping", () => {
  const now = new Date(2026, 10, 7, 0, 10).getTime(); // 00:10, just after midnight

  it("names today, yesterday and older days by calendar day", () => {
    expect(dayLabel(at(2026, 11, 7, 0, 5), now)).toBe("Today");
    expect(dayLabel(at(2026, 11, 6, 23, 55), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 11, 6, 0, 0), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 11, 5, 23, 59), now)).toBe("Nov 5, 2026");
    expect(dayLabel(at(2026, 10, 1), now)).toBe("Oct 1, 2026");
  });

  it("an entry a little in the future still counts as today", () => {
    expect(dayLabel(at(2026, 11, 7, 0, 30), now)).toBe("Today");
  });

  it("puts each run of one day under one heading, keeping the order", () => {
    const g = groupByDay([item(5, { at: at(2026, 11, 7, 0, 5) }), item(4, { at: at(2026, 11, 6, 23, 55) }), item(3, { at: at(2026, 11, 6, 9) }), item(2, { at: at(2026, 11, 2) })], now);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([["Today", [5]], ["Yesterday", [4, 3]], ["Nov 2, 2026", [2]]]);
  });
});

describe("ActivityFeed", () => {
  it("shows entries under day headings with the contract linked, and the full time on hover", async () => {
    stubApi({ "GET /activity": () => ({ items: [item(2, { at: new Date().toISOString() }), item(1, { at: at(2020, 1, 5), studyId: null, studyTitle: null, summary: "Someone did a thing" })], next: null } satisfies ActivityPage) });
    renderWithClient(<ActivityFeed />);
    expect(await screen.findByText("Entry 2")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Jan 5, 2020" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "NWP-418-02" }).getAttribute("href")).toBe("/studies/s1");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Someone did a thing").closest("li")!.querySelector("time")!.getAttribute("title")).toMatch(/2020/);
    expect(screen.queryByRole("button", { name: "Show earlier activity" })).toBeNull();
  });

  it("loads the next page with `before` and appends it", async () => {
    const fetch = stubApi({
      "GET /activity": (url) =>
        url.searchParams.get("before") === "10"
          ? ({ items: [item(9, { at: at(2020, 1, 5) })], next: null } satisfies ActivityPage)
          : ({ items: [item(10)], next: 10 } satisfies ActivityPage),
    });
    renderWithClient(<ActivityFeed />);
    await screen.findByText("Entry 10");
    fireEvent.click(screen.getByRole("button", { name: "Show earlier activity" }));
    expect(await screen.findByText("Entry 9")).toBeTruthy();
    expect(screen.getByText("Entry 10")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show earlier activity" })).toBeNull());
    expect(fetch.mock.calls.map(([u]) => String(u))).toEqual([expect.stringContaining("/activity?limit="), expect.stringContaining("before=10")]);
  });

  it("says so when nothing has happened", async () => {
    stubApi({ "GET /activity": () => ({ items: [], next: null }) });
    renderWithClient(<ActivityFeed />);
    expect(await screen.findByText("Nothing has happened here yet.")).toBeTruthy();
  });

  it("shows a skeleton while loading, then an error with a retry that works", async () => {
    let fail = true;
    stubApi({ "GET /activity": () => (fail ? new Response(JSON.stringify({ message: "boom" }), { status: 500 }) : { items: [item(1)], next: null }) });
    renderWithClient(<ActivityFeed />);
    expect(screen.getByRole("status", { name: "Loading activity" })).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/boom/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Entry 1")).toBeTruthy();
  });
});

describe("HistoryTab", () => {
  it("sends the contract as `study`, explains itself and leaves out the contract links", async () => {
    const fetch = stubApi({ "GET /activity": () => ({ items: [item(1)], next: null }) });
    renderWithClient(<HistoryTab studyId="s7" />);
    expect(await screen.findByText("Entry 1")).toBeTruthy();
    expect(screen.getByText("Who did what on this contract, newest first. It can't be edited.")).toBeTruthy();
    expect(String(fetch.mock.calls[0]![0])).toContain("study=s7");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
