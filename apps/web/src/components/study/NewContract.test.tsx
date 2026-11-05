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

describe("new contract", () => {
  it("asks only for the PDFs", () => {
    stubApi({});
    renderWithClient(<NewContract />);
    expect(screen.getByRole("heading", { name: "New contract" })).toBeTruthy();
    expect(screen.getByText("Drop the signed contract and any amendments. We'll read the study details from them.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose PDFs" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("creates the study, uploads each file on its own, then opens the study", async () => {
    const fetch = stubApi({
      "POST /studies": () => ({ id: "s9" }),
      "POST /studies/s9/documents": () => [{ id: "d1", name: "x", pages: 2, scannedPages: [], alreadyInStudy: false }],
    });
    renderWithClient(<NewContract />);
    drop("CTA.pdf", "Amendment 1.pdf");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/studies/s9"));
    expect(posts(fetch)).toEqual(["/api/v1/studies", "/api/v1/studies/s9/documents", "/api/v1/studies/s9/documents"]);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ by: "Avery Chen" });
  });

  it("keeps the files that went through and says in plain words which one didn't, instead of moving on", async () => {
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
    expect(screen.getByRole("link", { name: "Open the contract" }).getAttribute("href")).toBe("/studies/s9");
    expect(push).not.toHaveBeenCalled();
  });

  it("asks for a name before creating anything", () => {
    setActingAs(null);
    const fetch = stubApi({});
    renderWithClient(<NewContract />);
    drop("CTA.pdf");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so, and lets you drop again, when the study can't be created", async () => {
    stubApi({ "POST /studies": () => Response.json({ message: "Say who is doing this: pick your name first." }, { status: 400 }) });
    renderWithClient(<NewContract />);
    drop("CTA.pdf");
    expect(await screen.findByText("Say who is doing this: pick your name first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose PDFs" })).toBeTruthy();
  });
});
