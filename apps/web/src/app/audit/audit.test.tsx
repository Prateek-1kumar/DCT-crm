import type { AuditEntryDto } from "@dct/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import AuditPage from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let n = 0;
const entry = (action: string, detail: Record<string, unknown>): AuditEntryDto => ({ id: `a${++n}`, at: "2026-10-28T10:00:00.000Z", by: "Asha Patel", studyId: "st-1", protocol: "HAL-2207", sponsor: "Halcyon", action, detail });
const docId = "baa7d173-0b1e-4c55-9f0e-1f6f2a3c4d5e";

/** Each entry's Details cell, as it reads. */
async function detailsOf(entries: AuditEntryDto[]) {
  vi.spyOn(api, "audit").mockResolvedValue({ items: entries, nextCursor: null });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuditPage />
    </QueryClientProvider>,
  );
  await screen.findByRole("table");
  return screen.getAllByRole("row").slice(1).map((r) => r.querySelectorAll("td")[4]!.textContent!);
}

describe("Activity details", () => {
  it("read in plain words: labels for values, no ids, no codes, no raw data", async () => {
    const cells = await detailsOf([
      entry("value.typed", { version: 2, path: "/payment/netDays/value", value: "Payment › Net days", before: null, after: 45 }),
      entry("review.answered", { version: 1, itemId: "confirm:/budgetGrids/0/visits/1/totalCents", question: "What is the Week 0 total?", outcome: "differs", path: "/budgetGrids/0/visits/1/totalCents", before: 848800, after: 848900, items: ["g1", "V2"] }),
      entry("review.answered", { version: 1, itemId: "grid", question: "Which budget do we bill from?", outcome: "chosen", gridId: "g2" }),
      entry("document.kind_set", { documentId: docId, from: "other", to: "work_order" }),
      entry("document.uploaded", { documentId: docId, filename: "Work order.pdf", sha256: "ab12", pageCount: 4, text: "text" }),
      entry("study.created", { documentIds: [docId] }),
      entry("study.confirmed", { before: { sponsor: null, protocol: "HAL-2207", siteName: null, investigator: null }, after: { sponsor: "Halcyon", protocol: "HAL-2207", siteName: "DCT North", investigator: "Dr Rao" } }),
      entry("study.identified", { documentKinds: { [docId]: "work_order", d2: "budget" }, studyGuess: { sponsor: "Halcyon", protocol: "HAL-2207", siteName: null, investigator: "Dr Rao" } }),
      entry("extraction.queued", { version: 2, jobId: "job-9", addedDocumentIds: [docId] }),
      entry("extraction.completed", { version: 2, anomalies: 1, questions: 9, pdfCheck: { values: 120, matched: 118 }, costUsd: 0.4213 }),
      entry("version.corrections_carried", { version: 2, from: 1, carried: [{ path: "/payment/netDays/value", before: 30, after: 45, by: "Ben", items: [] }], skipped: [{ path: "/holdback/pct", reason: "amendment_changed" }], grid: { from: "g1", to: "g2" } }),
      entry("settings.updated", { before: { makerChecker: false, people: ["Asha"] }, after: { makerChecker: true, people: ["Asha", "Ben"] } }),
      entry("version.signed", { version: 1, note: "Key terms checked: payment.", appliesFrom: "2025-08-22" }),
      entry("version.exported", { version: 1, format: "xlsx" }),
    ]);
    const all = cells.join("\n");
    for (const raw of [docId, "path", "documentId", "itemId", "jobId", "gridId", "g2", "sha256", "work_order", "/payment", "{", "}", "[", "undefined", "[object Object]"]) expect(all).not.toContain(raw);

    expect(cells[0]).toBe("Payment › Net daysVersion:2Before:Not statedAfter:45");
    expect(cells[1]).toBe("Version:1Question:What is the Week 0 total?Answer:Differs from the readingBefore:$8,488.00After:$8,489.00");
    expect(cells[2]).toBe("Version:1Question:Which budget do we bill from?Answer:Picked");
    expect(cells[3]).toBe("From:OtherTo:Work order");
    expect(cells[4]).toBe("File:Work order.pdfPages:4PDF:Text PDF");
    expect(cells[5]).toBe("");
    expect(cells[6]).toBe("Sponsor:— → HalcyonSite:— → DCT NorthPrincipal investigator:— → Dr Rao");
    expect(cells[7]).toBe("Files:Work order, BudgetFound on the cover pages:Sponsor: Halcyon · Protocol: HAL-2207 · Principal investigator: Dr Rao");
    expect(cells[8]).toBe("Version:2");
    expect(cells[9]).toBe("Version:2Contract problems:1Questions:9Checked against the PDF:118 of 120 numbers matchedReading cost:$0.42");
    expect(cells[10]).toBe("Version:2From version:1Carried over:Payment › Net days: 30 → 45Not carried over:Holdback › Percent (the amendment changed it)");
    expect(cells[11]).toBe("A second person approves:No → YesPeople:Asha → Asha, Ben");
    expect(cells[12]).toBe("Version:1Note:Key terms checked: payment.Applies from:Aug 22, 2025");
    expect(cells[13]).toBe("Version:1Format:Excel");
  });

  it("shows only what the API sent for a value still being answered blind", async () => {
    // The API leaves out before/after and blanks the note's numbers while the question is open.
    const [cell] = await detailsOf([entry("number.reported", { version: 2, path: "/budgetGrids/0/procedures/0/unitCents", value: "Budget grid › Blood draw › Unit price", note: "Should be ••• not •••" })]);
    expect(cell).toBe("Budget grid › Blood draw › Unit priceVersion:2Note:Should be ••• not •••");
  });
});
