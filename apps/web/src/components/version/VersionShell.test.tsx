import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { question, mockApi, renderWithClient, rulebook, version } from "./fixtures";
import { VersionShell } from "./VersionShell";

vi.mock("next/navigation", () => ({ usePathname: () => "/versions/v1/questions" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const study = { id: "s1", protocol: "NWP-418" };
const shell = () => renderWithClient(<VersionShell versionId="v1"><p>page body</p></VersionShell>);

describe("VersionShell", () => {
  it("shows the study, version, status and the open question counts on the Questions tab", async () => {
    mockApi({
      "GET /versions/v1": () =>
        version({
          rulebook: rulebook({
            questions: [question("a"), question("b"), question("c", { blocking: false }), question("d", { state: "answered" })],
          }),
        }),
      "GET /studies/s1": () => study,
    });
    shell();
    expect(await screen.findByRole("heading", { level: 1, name: "Version 3" })).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(await screen.findByRole("link", { name: /NWP-418/ })).toHaveProperty("href", expect.stringContaining("/studies/s1"));
    expect(screen.getByText("2 to answer")).toBeTruthy();
    expect(screen.getByText("1 worth a look")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Questions/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Summary" }).getAttribute("href")).toBe("/versions/v1");
    expect(screen.getByRole("link", { name: "Proof" }).getAttribute("href")).toBe("/versions/v1/proof");
    expect(screen.getByRole("link", { name: "Approve" }).getAttribute("href")).toBe("/versions/v1/approve");
    expect(screen.getByText("page body")).toBeTruthy();
  });

  it("calls an approved version Live and shows no count when nothing is open", async () => {
    mockApi({ "GET /versions/v1": () => version({ status: "approved" }), "GET /studies/s1": () => study });
    shell();
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.queryByText(/to answer/)).toBeNull();
  });

  it("says a version is still being read, links to the study and hides the pages", async () => {
    mockApi({ "GET /versions/v1": () => version({ status: "reading", rulebook: null }), "GET /studies/s1": () => study });
    shell();
    expect(await screen.findByText("We're still reading this contract")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the study" }).getAttribute("href")).toBe("/studies/s1");
    expect(screen.queryByText("page body")).toBeNull();
    expect(screen.queryByRole("link", { name: "Proof" })).toBeNull();
  });

  it("shows why a failed version failed", async () => {
    mockApi({
      "GET /versions/v1": () => version({ status: "failed", rulebook: null, read: { id: "r1", status: "failed" } }),
      "GET /studies/s1": () => study,
      "GET /reads/r1": () => ({ error: "The scan was too faint to read." }),
    });
    shell();
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(await screen.findByText("The scan was too faint to read.")).toBeTruthy();
  });
});
