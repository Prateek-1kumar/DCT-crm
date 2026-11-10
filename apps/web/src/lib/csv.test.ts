import { describe, expect, it } from "vitest";
import { dollars, fileSafe, toCsv } from "./csv";

describe("toCsv", () => {
  it("quotes commas, quotes and line breaks, keeps numbers as numbers and blanks as blanks", () => {
    expect(toCsv([["Name", "Amount"], ['Fee, "startup"', 1234.5], ["two\nlines", null]])).toBe('Name,Amount\r\n"Fee, ""startup""",1234.5\r\n"two\nlines",');
  });

  it("makes a cell that starts like a formula plain text, so contract wording can't run in Excel", () => {
    expect(toCsv([["=HYPERLINK(1)", "+1", "-2", "@x", -2]])).toBe("'=HYPERLINK(1),'+1,'-2,'@x,-2");
  });
});

describe("dollars", () => {
  it("turns integer cents into a plain number of dollars", () => {
    expect([dollars(123456), dollars(5), dollars(-1205), dollars(0), dollars(null)]).toEqual([1234.56, 0.05, -12.05, 0, null]);
  });
});

describe("fileSafe", () => {
  it("keeps a file name to letters, digits, dots and dashes", () => {
    expect(fileSafe("EFC 18243: v1 / budget grid")).toBe("EFC-18243-v1-budget-grid");
    expect(fileSafe("///")).toBe("export");
  });
});
