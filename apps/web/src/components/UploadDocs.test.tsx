import type { DocumentDto } from "@dct/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import NewStudyPage from "@/app/studies/new/page";
import { DocList, Dropzone, newDocs } from "./UploadDocs";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const doc = (id: string, more: Partial<DocumentDto> = {}): DocumentDto => ({
  id, filename: `${id}.pdf`, sha256: id, kind: "master_agreement", pageCount: 12, text: "text", uploadedAt: "2026-10-01T00:00:00.000Z", duplicateOf: null, ...more,
});
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => localStorage.setItem("dct.actingAs", "Asha Patel"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("files uploaded before", () => {
  it("are kept, once each, by document id", () => {
    const msa = doc("msa", { duplicateOf: "msa" });
    expect(newDocs([], [msa])).toEqual([msa]);
    expect(newDocs([doc("wo")], [msa, doc("wo"), { ...msa, filename: "copy of msa.pdf" }])).toEqual([msa]);
  });

  it("say plainly that the stored copy is used, keep their kind menu, and still say it is a printed copy or scan, asking for the original", () => {
    wrap(<DocList docs={[doc("msa", { duplicateOf: "msa", text: "scan" })]} onChange={() => {}} />);
    expect(screen.getByText("Uploaded before · will be used")).toBeTruthy();
    expect(screen.queryByText("Already added")).toBeNull();
    expect(screen.getByLabelText("What kind of file msa.pdf is")).toBeTruthy();
    expect(screen.getByText(/· Printed copy or scan/)).toBeTruthy();
    expect(screen.getByText(/upload that instead: its numbers are read exactly/)).toBeTruthy();
  });

  it("can start a new contract: a site's master agreement shared with another study", async () => {
    vi.spyOn(api, "upload").mockResolvedValue([doc("msa", { duplicateOf: "msa" })]);
    const create = vi.spyOn(api, "createStudy").mockResolvedValue({ studyId: "st-2", jobId: "j-2" });
    wrap(<NewStudyPage />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => fireEvent.change(input, { target: { files: [new File(["%PDF"], "Master agreement.pdf", { type: "application/pdf" })] } }));
    const go = await screen.findByRole("button", { name: /Continue with 1 file/ });
    expect((go as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.click(go));
    expect(create).toHaveBeenCalledWith(["msa"], "Asha Patel");
  });
});

describe("choosing files that aren't the contract (ADR-003 P1)", () => {
  it("a spreadsheet and a Word file each say what they are and what to upload instead; nothing is sent", () => {
    localStorage.setItem("dct.actingAs", "Sam Rivera");
    const sent = vi.spyOn(api, "upload");
    const { container } = wrap(<Dropzone onUploaded={() => {}} />);
    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["x"], "Ex A-1 Final.xlsx"), new File(["x"], "Cheat sheet.docx")] } });
    expect(screen.getByText("Ex A-1 Final.xlsx is a spreadsheet. Upload the signed contract PDF: its budget is read from there. A budget spreadsheet can't be read yet.")).toBeTruthy();
    expect(screen.getByText("Cheat sheet.docx is a Word document, not the signed contract. Upload the signed contract PDF (the DocuSign copy).")).toBeTruthy();
    expect(sent).not.toHaveBeenCalled();
  });
});
