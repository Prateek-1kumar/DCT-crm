import { describe, expect, it } from "vitest";
import { excludedPagesWords, isExcludedPage } from "../src";

describe("pages the read doesn't read or sweep", () => {
  it("only the four exclusion kinds are excluded; every older kind is read and swept as before", () => {
    for (const kind of ["esign_certificate", "esign_disclosure", "reference_appendix", "non_content"]) expect(isExcludedPage({ kind })).toBe(true);
    for (const kind of ["terms", "budget_grid", "invoiceables", "signatures", "boilerplate"]) expect(isExcludedPage({ kind })).toBe(false);
  });

  it("says which pages, why, and where to look; marks a page that prints an amount", () => {
    const words = excludedPagesWords([
      { filename: "a.pdf", page: 13, kind: "esign_certificate" },
      { filename: "a.pdf", page: 14, kind: "esign_certificate" },
      { filename: "a.pdf", page: 17, kind: "esign_disclosure", money: true },
      { filename: "b.pdf", page: 3, kind: "reference_appendix" },
      { filename: "b.pdf", page: 1, kind: "non_content", money: false },
    ]);
    expect(words).toContain("pages 13–14 of “a.pdf” (an e-signature record)");
    expect(words).toContain("page 17 of “a.pdf” (an e-signature legal notice)");
    expect(words).toContain("page 3 of “b.pdf” (a reference list with no payment terms)");
    expect(words).toContain("page 1 of “b.pdf” (a blank separator or cover sheet with no numbers)");
    expect(words).toContain("a blank separator or cover sheet:");
    expect(words).toContain("One of them prints a dollar amount: page 17 of “a.pdf”");
    expect(words).toContain("Open them in Documents");
    expect(excludedPagesWords([{ filename: "a.pdf", page: 2, kind: "esign_certificate" }])).not.toContain("dollar amount");
    expect(excludedPagesWords([{ filename: "a.pdf", page: 2, kind: "esign_certificate", money: false }])).not.toMatch(/dollar amount|could not be checked/);
  });

  it("says plainly when a scan's amounts could not be checked, and tells the accountant to look and add any fee by hand", () => {
    const words = excludedPagesWords([
      { filename: "s.pdf", page: 4, kind: "esign_certificate", money: null },
      { filename: "s.pdf", page: 5, kind: "esign_disclosure", money: null },
      { filename: "s.pdf", page: 6, kind: "reference_appendix", money: true },
    ]);
    expect(words).toContain("The amounts on pages 4–5 of “s.pdf” could not be checked, so look at them first and add any fee by hand.");
    expect(words).toContain("One of them prints a dollar amount: page 6 of “s.pdf”");
  });
});
