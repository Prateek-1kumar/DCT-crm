import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import type { Study, StudyRow, VersionStatus } from "@/lib/types";
import { doc, read, renderWithClient, study, stubApi, stubDialog, version as summary } from "../study/test-helpers";
import { rulebook, version as fullVersion } from "../version/fixtures";
import { Workspace } from "./Workspace";

let params = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => params, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

beforeEach(() => {
  setActingAs("Avery Chen");
  stubDialog();
});
afterEach(() => {
  params = new URLSearchParams();
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

const row = (over: Partial<StudyRow> = {}): StudyRow => ({
  id: "s1", protocol: "NWP-418-02", sponsorId: "p1", payerId: "p2", siteId: "p3", createdAt: "2026-11-01T10:00:00Z", createdBy: "Avery Chen", sponsor: "Northwind Pharma", payer: "Fieldstone CRO",
  site: "Discovery Clinical Trials", firstDocument: "Contract.pdf", latestVersion: null, pi: "Dr. Priya Raman", updatedAt: "2026-11-02T09:30:00Z", liveVersion: null, openDecisions: 0, newVersionInProgress: false, answeredBy: [], ...over,
});

type Setup = { detail?: Partial<Study>; status?: VersionStatus | null; row?: Partial<StudyRow>; docs?: ReturnType<typeof doc>[]; versions?: ReturnType<typeof summary>[]; read?: Partial<ReturnType<typeof read>>; effectiveDate?: string | null };

function open(o: Setup = {}) {
  const status = o.status === undefined ? null : o.status;
  const versions = o.versions ?? (status ? [summary({ status, approvedBy: "Sam Lee", approvedAt: "2026-11-03T09:00:00Z" })] : []);
  const latest = versions[0];
  const fetch = stubApi({
    "GET /studies/s1": () => study({ documents: o.docs ?? [doc()], versions, ...o.detail }),
    "GET /studies": () => [row({ latestVersion: latest ? { id: latest.id, number: latest.number, status: latest.status } : null, ...o.row })],
    "GET /versions/v1": () => fullVersion({ id: "v1", number: 1, status: status ?? "draft", read: { id: "r1", status: o.read?.status ?? "running" }, rulebook: rulebook({ study: { ...rulebook().study, effectiveDate: o.effectiveDate ?? null } }) }),
    "GET /versions/v0": () => fullVersion({ id: "v0", number: 1, status: "superseded" }),
    "GET /versions/v1/coverage": () => ({ pages: [], totals: { amounts: 0, captured: 0, decided: 0, setAside: 0, missing: 0 } }),
    "GET /reads/r1": () => read(o.read),
    "POST /studies/s1/reads": () => ({ readId: "r1", versionId: "v1" }),
  });
  renderWithClient(<Workspace id="s1" />);
  return fetch;
}

describe("header", () => {
  it("shows the protocol, parties and doctor, and a search box", async () => {
    open({ status: "draft", row: { openDecisions: 2 } });
    expect(await screen.findByRole("heading", { level: 1, name: "NWP-418-02" })).toBeTruthy();
    expect(screen.getByText("Dr. Priya Raman")).toBeTruthy();
    // the three parties are chips of their own, each with a way to change it
    for (const slot of ["Sponsor", "CRO", "Site"]) expect(screen.getByRole("button", { name: new RegExp(`Change ${slot}`) })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search this contract" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
  });

  it("names an unread contract by its first file and says where the details will come from", async () => {
    open({ docs: [doc({ name: "Master CTA.pdf" })], detail: { protocol: null, sponsor: null, payer: null, site: null }, row: { protocol: null, sponsor: null, payer: null, site: null, pi: null } });
    expect(await screen.findByRole("heading", { level: 1, name: "Master CTA.pdf" })).toBeTruthy();
    expect(screen.getByText("Study details are filled in when the contract is read")).toBeTruthy();
  });

  it("shows the new-version tag on a live contract", async () => {
    open({ status: "reading", row: { liveVersion: 1, newVersionInProgress: true } });
    expect(await screen.findByText("New version in progress")).toBeTruthy();
  });

  it("shows a skeleton while loading and a plain message when it can't load", async () => {
    stubApi({ "GET /studies/s1": () => new Promise(() => {}), "GET /studies": () => [] });
    renderWithClient(<Workspace id="s1" />);
    expect(screen.getByLabelText("Loading this contract")).toBeTruthy();
    cleanup();
    stubApi({});
    renderWithClient(<Workspace id="s1" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/We can't find this|didn't load/);
  });
});

describe("stepper and banner", () => {
  const stepNote = (label: string) => screen.getByRole("list", { name: "Where this contract is" }).querySelectorAll("li")[["Add files", "Reading", "Decisions", "Approve", "Live"].indexOf(label)]!;

  it("step 1: add files, opening on the Documents tab", async () => {
    open({ docs: [], row: { firstDocument: null } });
    expect(await screen.findByRole("heading", { name: "Add the signed contract" })).toBeTruthy();
    expect(stepNote("Add files").textContent).toContain("No files yet");
    expect(screen.getByRole("tab", { name: "Documents" }).getAttribute("aria-selected")).toBe("true");
  });

  it("ready to read: Start reading starts it", async () => {
    const fetch = open({});
    fireEvent.click(await screen.findByRole("button", { name: "Start reading" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => String(u) === "/api/v1/studies/s1/reads" && i?.method === "POST" && JSON.parse(i.body as string).by === "Avery Chen")).toBe(true));
  });

  it("decisions: says how many and links to the questions", async () => {
    open({ status: "draft", row: { openDecisions: 3 } });
    expect(await screen.findByRole("heading", { name: "3 decisions need you" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Answer 3 decisions" }).getAttribute("href")).toBe("/versions/v1/questions");
    expect(stepNote("Decisions").textContent).toContain("3 decisions to make");
  });

  it("approve: links to the approve page, or is off for the person who answered, naming them", async () => {
    open({ status: "draft", row: { answeredBy: ["Avery Chen"] } });
    expect(await screen.findByRole("heading", { name: "Ready to review and approve" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Waiting for a colleague" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Avery Chen answered the decisions/)).toBeTruthy();
    cleanup();
    open({ status: "draft", row: { answeredBy: ["Sam Lee"] } });
    expect((await screen.findByRole("link", { name: "Review and approve" })).getAttribute("href")).toBe("/versions/v1/approve");
  });

  it("live: opens the rulebook", async () => {
    open({ status: "approved", row: { liveVersion: 1 } });
    expect((await screen.findByRole("link", { name: "Open rulebook" })).getAttribute("href")).toBe("/versions/v1");
    expect(await screen.findByRole("heading", { name: "Version 1 is live" })).toBeTruthy();
  });
});

describe("reading panel", () => {
  it("shows progress lines and how long it has run, with a bar and no money", async () => {
    open({ status: "reading", read: { status: "running" } });
    expect(await screen.findByText("Checking the visit grid")).toBeTruthy();
    expect(screen.getByText(/Reading for/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("28");
    expect(screen.getByText(/you can leave/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it("a failed read gives the read's own message, keeps scans, and starts again", async () => {
    const fetch = open({ status: "failed", read: { status: "failed", error: "The contract was too long for one reading." }, row: { latestVersion: { id: "v1", number: 1, status: "failed" } } });
    expect(await screen.findByText("The contract was too long for one reading.")).toBeTruthy();
    expect(screen.getByText(/already transcribed are kept/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => String(u).endsWith("/studies/s1/reads") && i?.method === "POST")).toBe(true));
  });
});

describe("version picker and tabs", () => {
  it("shows who approved the version, when, and when it applies from", async () => {
    open({ status: "approved", row: { liveVersion: 1 }, effectiveDate: "2026-01-15" });
    expect(await screen.findByText("Approved by Sam Lee · Nov 3, 2026 · applies from Jan 15, 2026")).toBeTruthy();
  });

  it("lists the readable versions, newest first, and says a draft isn't approved", async () => {
    open({ row: { latestVersion: { id: "v1", number: 2, status: "draft" } }, versions: [summary({ id: "v1", number: 2, status: "draft" }), summary({ id: "v0", number: 1, status: "superseded", approvedBy: "Sam Lee", approvedAt: "2026-11-03T09:00:00Z" })] });
    const picker = await screen.findByRole("combobox");
    expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Version 2 · Draft", "Version 1 · Replaced"]);
    expect(await screen.findByText("Not approved yet")).toBeTruthy();
    fireEvent.change(picker, { target: { value: "v0" } });
    expect(await screen.findByText(/Approved by Sam Lee/)).toBeTruthy();
  });

  it("has the six tabs and shows the real overview, then the budget grid", async () => {
    open({ status: "approved", row: { liveVersion: 1 } });
    const tabs = (await screen.findAllByRole("tab")).map((t) => t.textContent);
    expect(tabs).toEqual(["Overview", "Budget grid", "Fees & invoiceables", "Payment terms", "Documents", "History"]);
    expect(await screen.findByText("Key rules")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Budget grid" }));
    await waitFor(() => expect(screen.queryByText("Key rules")).toBeNull());
  });

  it("says the rulebook is not there yet when nothing has been read", async () => {
    open({});
    expect(await screen.findByText("Nothing to show yet")).toBeTruthy();
  });
});

describe("documents tab", () => {
  const goto = async () => fireEvent.click(await screen.findByRole("tab", { name: "Documents" }));

  it("lists each document with its pages and size", async () => {
    open({});
    await goto();
    expect(await screen.findByText("12 pages · 2.4 MB")).toBeTruthy();
  });

  it("says scanned pages take longer, with no cost, and which were already read", async () => {
    open({ docs: [doc({ scansRead: [3, 4], scannedPages: [5, 6, 7] })] });
    await goto();
    expect(await screen.findByText("Scanned pages 3–4 were read from the image.")).toBeTruthy();
    expect(screen.getByText("Scanned pages 5–7 are read from the image when the read starts. Scanned pages take longer to read.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\$|cost/i);
  });

  it("says nothing about scanning when there are no scans", async () => {
    open({});
    await goto();
    await screen.findByText("Contract.pdf");
    expect(screen.queryByText(/Scanned/)).toBeNull();
  });

  it("uploads, reporting a bad file in plain words", async () => {
    let n = 0;
    const fetch = stubApi({
      "GET /studies/s1": () => study(),
      "GET /studies": () => [row()],
      "POST /studies/s1/documents": () => (++n === 1 ? Response.json({ message: '"Notes.pdf" isn\'t a PDF. Upload PDF files only.' }, { status: 400 }) : [{ id: "d2", name: "Good.pdf", pages: 2, scannedPages: [], alreadyInStudy: false }]),
    });
    renderWithClient(<Workspace id="s1" />);
    await goto();
    await screen.findByText("Contract.pdf");
    fireEvent.change(screen.getByLabelText("Contract PDFs"), { target: { files: [new File(["x"], "Notes.pdf"), new File(["%PDF-1.7"], "Good.pdf")] } });
    expect(await screen.findByText('"Notes.pdf" isn\'t a PDF. Upload PDF files only.')).toBeTruthy();
    expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(2);
  });

  it("asks who is working instead of uploading when there is no name", async () => {
    setActingAs(null);
    const fetch = open({});
    await goto();
    await screen.findByText("Contract.pdf");
    fireEvent.change(screen.getByLabelText("Contract PDFs"), { target: { files: [new File(["%PDF-1.7"], "A.pdf")] } });
    expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(0);
  });

  it("opens on Documents when the address asks for it", async () => {
    params = new URLSearchParams("tab=documents");
    open({});
    expect((await screen.findByRole("tab", { name: "Documents" })).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel")).getByText("Contract.pdf")).toBeTruthy();
  });
});
