import { describe, expect, it } from "vitest";
import { lastSigned, signingDates } from "../src/esign";
import type { TextPage } from "../src/textlayer";

// Invented e-signature records, as words in reading order: the shapes signing services print (an event label, then its
// date and time), in several date formats. No vendor's name decides anything.
const page = (text: string, opts: { page?: number; source?: TextPage["source"]; hidden?: string } = {}): TextPage => ({
  documentId: "d",
  page: opts.page ?? 9,
  width: 600,
  height: 800,
  source: opts.source ?? "text",
  words: [...text.split(/\s+/).map((t) => ({ text: t, hidden: false })), ...(opts.hidden ?? "").split(/\s+/).filter(Boolean).map((t) => ({ text: t, hidden: true }))].map((w, i) => ({ ...w, rect: [0, i, 10, i + 1], dir: 0, block: 0, line: i })),
  hidden: 0,
  largePicture: false,
});
const dates = (p: TextPage) => signingDates(p).map((d) => d.values.join("|"));

describe("signingDates: a date counts only when the event word nearest before it is a signing", () => {
  it("an envelope's events: sent and viewed are not signings; signed and completed are", () => {
    const p = page("Signer Events Signature Timestamp A Signer Signature Adoption: Pre-selected Signed using mobile Sent: 3/14/2024 10:38:01 AM Viewed: 3/14/2024 1:15:54 PM Signed: 3/15/2024 1:17:04 PM Electronic Record and Signature Disclosure: Accepted: 3/14/2024 1:15:54 PM Envelope Sent Hashed/Encrypted 3/14/2024 Completed Security Checked 3/15/2024 1:17:04 PM");
    expect(dates(p)).toEqual(["2024-03-15", "2024-03-15"]);
  });

  it("an audit report's events: created, emailed for signature and viewed are not; the signature date and completion are", () => {
    const p = page("Audit Report Document created by A (a@x) 2023-08-14 - 1:03:05 PM GMT Document emailed to B (b@x) for signature 2023-08-14 - 1:08:54 PM GMT Email viewed by B 2023-08-15 Document e-signed by B Signature Date: 2023-08-16 - 1:29:25 PM GMT Agreement completed. 2023-08-16 - 1:29:25 PM GMT Document viewed by C 2023-09-02");
    expect(dates(p)).toEqual(["2023-08-16", "2023-08-16"]);
    expect(lastSigned([p])).toEqual({ date: "2023-08-16", printed: "2023-08-16", documentId: "d", page: 9 });
  });

  it("other wordings and date formats", () => {
    expect(dates(page("Signed on 22 October 2025 at 17:40 UTC"))).toEqual(["2025-10-22"]);
    expect(dates(page("Date Signed: Oct. 23, 2025"))).toEqual(["2025-10-23"]);
    expect(dates(page("Executed 23-Oct-2025 | 13:44"))).toEqual(["2025-10-23"]);
    expect(dates(page("Signing Complete Security Checked 22.10.2025 19:22"))).toEqual(["2025-10-22"]);
  });

  it("a date with no event word before it, hidden words, and a scan's or OCR's characters say nothing", () => {
    expect(dates(page("Certificate of completion Envelope 2024-03-04 Pages: 9"))).toEqual([]);
    expect(dates(page("Status: Completed Record Tracking Status: Original Holder: A Location: B C D E F G H I J K L M N O P Q R S T 2024-03-04"))).toEqual([]);
    expect(dates(page("Signed:", { hidden: "2024-03-04" }))).toEqual([]);
    expect(dates(page("Signed: 2024-03-04", { source: "ocr" }))).toEqual([]);
    expect(dates(page("Signed: 2024-03-04", { source: "image_only" }))).toEqual([]);
  });
});

describe("lastSigned: the latest date of signature on one document's record, or none rather than a guess", () => {
  it("the latest over the record's pages, where it's printed", () => {
    const r = lastSigned([page("Signed: 22-Oct-2025 19:22 Signed: 23-Oct-2025 09:28", { page: 18 }), page("Completed Security Checked 23-Oct-2025 13:44 Viewed: 24-Oct-2025", { page: 19 })]);
    expect(r).toEqual({ date: "2025-10-23", printed: "23-Oct-2025", documentId: "d", page: 18 });
  });

  it("an all-number date that reads two ways gives no date, unless the record shows which way it reads or it can't change the latest", () => {
    expect(lastSigned([page("Signed: 3/4/2024 1:17:04 PM Completed 3/4/2024")])).toBeNull();
    // another date in the same style with a day over 12: day first, so 3/4 is 3 April
    expect(lastSigned([page("Sent: 25/3/2024 Signed: 3/4/2024")])?.date).toBe("2024-04-03");
    // month first
    expect(lastSigned([page("Sent: 3/14/2024 Signed: 4/3/2024")])?.date).toBe("2024-04-03");
    // either reading is before the latest
    expect(lastSigned([page("Signed: 3/4/2024 Signed: 22 April 2024")])?.date).toBe("2024-04-22");
    // the record reads both ways: it contradicts itself
    expect(lastSigned([page("Sent: 25/3/2024 Viewed: 3/26/2024 Signed: 3/4/2024")])).toBeNull();
  });

  it("no record, a wet-ink signature page, or a scan: none", () => {
    expect(lastSigned([])).toBeNull();
    expect(lastSigned([page("By: ________ Name: A Title: B Date: 3 March 2024")])).toBeNull();
    expect(lastSigned([page("Signed: 2024-03-04", { source: "ocr" })])).toBeNull();
  });
});
