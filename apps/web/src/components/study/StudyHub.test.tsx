import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import type { ReadStatus, VersionStatus } from "@/lib/types";
import { nextStep } from "./NextStep";
import { StudyHub } from "./StudyHub";
import { doc, read, renderWithClient, study, stubApi, version } from "./test-helpers";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

beforeEach(() => setActingAs("Avery Chen"));
afterEach(() => {
  cleanup();
  setActingAs(null);
  vi.unstubAllGlobals();
});

const question = (state: "open" | "answered", blocking = true) => ({ id: `q-${Math.random()}`, state, blocking });
const detail = (status: ReadStatus, questions: ReturnType<typeof question>[] = []) => ({ id: "v1", read: { id: "r1", status }, rulebook: { questions } });

function hub(versionStatus: VersionStatus | null, extra: { readStatus?: ReadStatus; r?: Partial<ReturnType<typeof read>>; questions?: ReturnType<typeof question>[]; docs?: ReturnType<typeof doc>[] } = {}) {
  const readStatus = extra.readStatus ?? "running";
  stubApi({
    "GET /studies/s1": () => study({ documents: extra.docs ?? [doc()], versions: versionStatus ? [version({ status: versionStatus, approvedBy: "Sam Lee", approvedAt: "2026-11-03T09:00:00Z" })] : [] }),
    "GET /versions/v1": () => detail(readStatus, extra.questions),
    "GET /reads/r1": () => read({ status: readStatus, ...extra.r }),
  });
  renderWithClient(<StudyHub id="s1" />);
}

describe("next step", () => {
  const study0 = study();
  it("is chosen from the state of the study", () => {
    expect(nextStep({ ...study0, documents: [] }).kind).toBe("upload");
    expect(nextStep(study0).kind).toBe("start");
    const at = (status: VersionStatus) => nextStep({ ...study0, versions: [version({ status })] }).kind;
    expect(at("reading")).toBe("reading");
    expect(at("draft")).toBe("questions");
    expect(at("failed")).toBe("failed");
    expect(at("approved")).toBe("live");
  });

  it("looks at the newest version, whatever order they arrive in", () => {
    const versions = [version({ id: "old", number: 1, status: "superseded" }), version({ id: "new", number: 2, status: "draft" })];
    expect(nextStep({ ...study0, versions })).toMatchObject({ kind: "questions", version: { id: "new" } });
  });

  it("with no documents asks to upload", async () => {
    hub(null, { docs: [] });
    expect(await screen.findByRole("heading", { name: "Add the contract" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload contract" })).toBeTruthy();
  });

  it("with documents and no version offers to start reading, which starts it", async () => {
    const fetch = stubApi({
      "GET /studies/s1": () => study(),
      "POST /studies/s1/reads": () => ({ readId: "r1", versionId: "v1" }),
    });
    renderWithClient(<StudyHub id="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start reading" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => String(u) === "/api/v1/studies/s1/reads" && i?.method === "POST" && JSON.parse(i.body as string).by === "Avery Chen")).toBe(true));
  });

  it("won't start while a document has scanned pages, and says why", async () => {
    hub(null, { docs: [doc({ scannedPages: [3, 4, 5] })] });
    const button = await screen.findByRole("button", { name: "Start reading" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Contract\.pdf has scanned pages that can't be read yet/)).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("for a draft links to the questions", async () => {
    hub("draft", { readStatus: "done", questions: [question("open"), question("open"), question("answered"), question("open", false)] });
    expect(await screen.findByRole("heading", { name: "Reading finished: 2 questions need you" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Answer questions" })[0]!.getAttribute("href")).toBe("/versions/v1/questions");
  });

  it("for a failed version gives the reason and a way to start again", async () => {
    hub("failed", { readStatus: "failed", r: { error: "The contract was too long for one reading." } });
    expect(await screen.findByText("The contract was too long for one reading.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start reading again" })).toBeTruthy();
  });

  it("for a live version opens the rulebook", async () => {
    hub("approved", { readStatus: "done" });
    const link = await screen.findByRole("link", { name: "Open live rulebook" });
    expect(link.getAttribute("href")).toBe("/versions/v1");
    expect(screen.getByText("Version 1 was approved by Sam Lee.")).toBeTruthy();
  });
});

describe("header", () => {
  it("shows the protocol, with the sponsor, payer and site under it, once the contract is read", async () => {
    stubApi({ "GET /studies/s1": () => study() });
    renderWithClient(<StudyHub id="s1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "NWP-418-02" })).toBeTruthy();
    expect(screen.getByText("Northwind Pharma · Fieldstone CRO · Discovery Clinical Trials")).toBeTruthy();
  });

  it("leaves out a payer the contract doesn't name", async () => {
    stubApi({ "GET /studies/s1": () => study({ payer: null }) });
    renderWithClient(<StudyHub id="s1" />);
    expect(await screen.findByText("Northwind Pharma · Discovery Clinical Trials")).toBeTruthy();
  });

  it("shows the first document's name until the contract is read, and says where the details will come from", async () => {
    stubApi({ "GET /studies/s1": () => study({ protocol: null, sponsor: null, payer: null, site: null, documents: [doc({ name: "Master CTA.pdf" }), doc({ id: "d2", name: "Amendment 1.pdf" })] }) });
    renderWithClient(<StudyHub id="s1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Master CTA.pdf" })).toBeTruthy();
    expect(screen.getByText("Study details are filled in when the contract is read")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start reading" })).toBeTruthy();
  });
});

describe("reading feed", () => {
  it("shows the progress lines, how long it has run and the spend", async () => {
    hub("reading", { readStatus: "running" });
    expect(await screen.findByText("Reading the payment schedule")).toBeTruthy();
    expect(screen.getByText("Checking the visit grid")).toBeTruthy();
    expect(screen.getByRole("log").textContent).toContain("Checking the visit grid");
    expect(screen.getByText(/\$0\.84 of \$3\.00/)).toBeTruthy();
    expect(screen.getByText(/Reading for/)).toBeTruthy();
  });

  it("keeps polling while the read is running, then reports that it finished", async () => {
    let calls = 0;
    let versionStatus: VersionStatus = "reading";
    stubApi({
      "GET /studies/s1": () => study({ versions: [version({ status: versionStatus })] }),
      "GET /versions/v1": () => detail(versionStatus === "reading" ? "running" : "done", [question("open")]),
      "GET /reads/r1": () => {
        calls++;
        if (calls < 2) return read({ status: "running" });
        versionStatus = "draft";
        return read({ status: "done", finishedAt: "2026-11-02T09:31:00Z", progress: ["Reading the payment schedule", "Done"] });
      },
    });
    renderWithClient(<StudyHub id="s1" />);
    expect(await screen.findByText("Checking the visit grid")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Reading finished: 1 question needs you" }, { timeout: 5000 })).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 10_000);
});

describe("documents", () => {
  it("lists each document with its pages and size, and warns about scanned pages", async () => {
    hub(null, { docs: [doc({ scannedPages: [3, 4, 5, 8] })] });
    expect(await screen.findByText("12 pages · 2.4 MB")).toBeTruthy();
    expect(screen.getByText("Pages 3–5, 8 are scans. Scanned contracts can't be read yet, because bank details on them can't be hidden.")).toBeTruthy();
  });

  it("shows the warning after an upload that brings in scanned pages", async () => {
    let docs = [doc()];
    const fetch = stubApi({
      "GET /studies/s1": () => study({ documents: docs }),
      "POST /studies/s1/documents": () => {
        docs = [...docs, doc({ id: "d2", name: "Amendment.pdf", pageCount: 6, scannedPages: [3, 4, 5] })];
        return [{ id: "d2", name: "Amendment.pdf", pages: 6, scannedPages: [3, 4, 5], alreadyInStudy: false }];
      },
    });
    renderWithClient(<StudyHub id="s1" />);
    await screen.findByText("Contract.pdf");
    const file = new File(["%PDF-1.7"], "Amendment.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Contract PDFs"), { target: { files: [file] } });
    expect(await screen.findByText(/Pages 3–5 are scans\./)).toBeTruthy();
    expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Start reading" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uploads several files one after another and reports the one that failed in plain words", async () => {
    let n = 0;
    stubApi({
      "GET /studies/s1": () => study(),
      "POST /studies/s1/documents": () => {
        n++;
        return n === 1 ? Response.json({ message: '"Notes.pdf" isn\'t a PDF. Upload PDF files only.' }, { status: 400 }) : [{ id: "d2", name: "Good.pdf", pages: 2, scannedPages: [], alreadyInStudy: false }];
      },
    });
    renderWithClient(<StudyHub id="s1" />);
    await screen.findByText("Contract.pdf");
    const files = [new File(["x"], "Notes.pdf"), new File(["%PDF-1.7"], "Good.pdf")];
    fireEvent.change(screen.getByLabelText("Contract PDFs"), { target: { files } });
    expect(await screen.findByText('"Notes.pdf" isn\'t a PDF. Upload PDF files only.')).toBeTruthy();
    expect(n).toBe(2);
  });

  it("asks who is working instead of uploading when there is no name", async () => {
    setActingAs(null);
    const fetch = stubApi({ "GET /studies/s1": () => study() });
    renderWithClient(<StudyHub id="s1" />);
    await screen.findByText("Contract.pdf");
    fireEvent.change(screen.getByLabelText("Contract PDFs"), { target: { files: [new File(["%PDF-1.7"], "A.pdf")] } });
    expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(0);
  });
});

describe("versions history", () => {
  it("lists every version with its pill, who and when, and links", async () => {
    stubApi({
      "GET /studies/s1": () => study({ versions: [version({ id: "v2", number: 2, status: "draft" }), version({ id: "v1", number: 1, status: "superseded", approvedBy: "Sam Lee", approvedAt: "2026-11-03T09:00:00Z" })] }),
      "GET /versions/v2": () => detail("done"),
      "GET /reads/r1": () => read({ status: "done" }),
    });
    renderWithClient(<StudyHub id="s1" />);
    expect(await screen.findByText("Superseded")).toBeTruthy();
    expect(screen.getAllByText("Questions to answer").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open rulebook" }).getAttribute("href")).toBe("/versions/v1");
    expect(screen.getByText(/Approved by Sam Lee/)).toBeTruthy();
  });
});
