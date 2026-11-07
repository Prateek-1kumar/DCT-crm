import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActingAs } from "@/lib/acting-as";
import { NewContract } from "./NewContract";
import { renderWithClient, stubApi } from "./test-helpers";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: ReactNode }) => <a href={href} {...p}>{children}</a> }));

beforeEach(() => setActingAs("Avery Chen"));
afterEach(() => {
  cleanup();
  setActingAs(null);
  push.mockReset();
  vi.unstubAllGlobals();
});

const drop = (...names: string[]) => fireEvent.change(screen.getByLabelText("Contract PDFs"), { target: { files: names.map((n) => new File(["%PDF-1.7"], n)) } });
const posts = (fetch: ReturnType<typeof stubApi>) => fetch.mock.calls.filter(([, i]) => i?.method === "POST").map(([u]) => String(u));

describe("add contract", () => {
  it("turns away a file that isn't a PDF, without creating a contract", async () => {
    const fetch = stubApi({});
    renderWithClient(<NewContract />);
    fireEvent.change(screen.getByLabelText("Contract PDFs"), { target: { files: [new File(["x"], "notes.docx")] } });
    expect(await screen.findByText("notes.docx isn't a PDF, so it was left out.")).toBeTruthy();
    expect(posts(fetch)).toEqual([]);
  });

  it("turns away a file already in the list and takes back one added by mistake", async () => {
    const fetch = stubApi({
      "POST /studies": () => ({ id: "s9" }),
      "POST /studies/s9/documents": () => [{ id: "d1", name: "x", pages: 2, scannedPages: [], alreadyInStudy: false }],
      "DELETE /studies/s9/documents/d1": () => ({ ok: true }),
    });
    renderWithClient(<NewContract />);
    drop("CTA.pdf");
    expect(await screen.findByText("1 file · 2 pages")).toBeTruthy();
    drop("CTA.pdf");
    expect(await screen.findByText("CTA.pdf is already in your list.")).toBeTruthy();
    expect(posts(fetch)).toEqual(["/api/v1/studies", "/api/v1/studies/s9/documents"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove CTA.pdf" }));
    await waitFor(() => expect(screen.queryByText("1 file · 2 pages")).toBeNull());
    expect(fetch.mock.calls.some(([u, i]) => i?.method === "DELETE" && String(u).startsWith("/api/v1/studies/s9/documents/d1"))).toBe(true);
  });

  it("asks only for the PDFs, with no start button until something is added", () => {
    stubApi({});
    renderWithClient(<NewContract />);
    expect(screen.getByRole("heading", { name: "Add contract" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose PDFs" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start reading" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("creates the study on the first drop, shows each file's pages and scans, and never mentions cost", async () => {
    const fetch = stubApi({
      "POST /studies": () => ({ id: "s9" }),
      "POST /studies/s9/documents": () => [{ id: "d1", name: "x", pages: 12, scannedPages: [3, 4, 5], alreadyInStudy: false }],
    });
    renderWithClient(<NewContract />);
    drop("CTA.pdf");
    // the row says "12 pages · size" and the summary line says "1 file · 12 pages · 3 scanned"
    expect((await screen.findAllByText(/12 pages/)).length).toBe(2);
    expect(screen.getByText("1 file · 12 pages · 3 scanned")).toBeTruthy();
    expect(screen.getByText("Pages 3–5 are scans. Scanned pages take longer to read.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\$|cost|dollar/i);
    expect(posts(fetch)).toEqual(["/api/v1/studies", "/api/v1/studies/s9/documents"]);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ by: "Avery Chen" });
    expect(push).not.toHaveBeenCalled();
  });

  it("a second drop goes to the same contract, and Start reading starts it and opens the contract", async () => {
    const fetch = stubApi({
      "POST /studies": () => ({ id: "s9" }),
      "POST /studies/s9/documents": () => [{ id: "d1", name: "x", pages: 2, scannedPages: [], alreadyInStudy: false }],
      "POST /studies/s9/reads": () => ({ readId: "r1", versionId: "v1" }),
    });
    renderWithClient(<NewContract />);
    drop("CTA.pdf");
    await screen.findByText("Added");
    drop("Amendment 1.pdf");
    await waitFor(() => expect(screen.getAllByText("Added")).toHaveLength(2));
    expect(posts(fetch).filter((u) => u.endsWith("/studies"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Start reading" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/studies/s9"));
    expect(posts(fetch)).toContain("/api/v1/studies/s9/reads");
  });

  it("keeps the files that went through and says in plain words which one didn't", async () => {
    let n = 0;
    stubApi({
      "POST /studies": () => ({ id: "s9" }),
      "POST /studies/s9/documents": () => {
        n++;
        return n === 1 ? Response.json({ message: '"Notes.pdf" isn\'t a PDF. Upload PDF files only.' }, { status: 400 }) : [{ id: "d2", name: "Good.pdf", pages: 2, scannedPages: [], alreadyInStudy: false }];
      },
    });
    renderWithClient(<NewContract />);
    drop("Notes.pdf", "Good.pdf");
    expect(await screen.findByText('"Notes.pdf" isn\'t a PDF. Upload PDF files only.')).toBeTruthy();
    expect(screen.getByText("Couldn't add")).toBeTruthy();
    expect(screen.getByText("Added")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start reading" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("can't start reading when no file was added", async () => {
    stubApi({ "POST /studies": () => ({ id: "s9" }), "POST /studies/s9/documents": () => Response.json({ message: "That file isn't a PDF." }, { status: 400 }) });
    renderWithClient(<NewContract />);
    drop("Notes.pdf");
    expect(await screen.findByText("Couldn't add")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start reading" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for a name before creating anything", () => {
    setActingAs(null);
    const fetch = stubApi({});
    renderWithClient(<NewContract />);
    drop("CTA.pdf");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so, and lets you drop again, when the contract can't be created", async () => {
    stubApi({ "POST /studies": () => Response.json({ message: "Say who is doing this: pick your name first." }, { status: 400 }) });
    renderWithClient(<NewContract />);
    drop("CTA.pdf");
    expect(await screen.findByText("Say who is doing this: pick your name first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose PDFs" })).toBeTruthy();
  });
});
