/** Plain-word labels for enum-valued rulebook fields, keyed by field name. */
export const ENUM_LABELS: Record<string, Record<string, string>> = {
  visitPayment: { auto_edc: "Automatic (from EDC)", invoice: "By invoice", mixed: "Mixed", unspecified: "Not stated" },
  frequency: { monthly: "Monthly", quarterly: "Quarterly", other: "Other", unspecified: "Not stated" },
  appliesTo: {
    procedures_only: "Procedures only",
    procedures_and_staff: "Procedures and staff",
    all_per_patient_lines: "All per-patient lines",
    none: "None",
    unspecified: "Not stated",
  },
  rounding: { printed_amounts: "Use printed amounts", cents: "Round to cents", unspecified: "Not stated" },
  basis: { fixed: "Fixed", actual_cost: "Actual cost", per_procedure: "Per procedure", per_hour: "Per hour", per_mile: "Per mile" },
  paidVia: { auto_edc: "Automatic (from EDC)", invoice: "By invoice" },
  category: { procedure: "A procedure", non_procedure: "Not a procedure (staff time, stipends)" },
  trigger: {
    agreement_execution: "On agreement execution",
    study_initiation: "On study initiation",
    regulatory_package: "On regulatory package",
    closeout: "At closeout",
    annual: "Annually",
    per_event: "Per event",
    one_time: "One time",
    actual_cost: "At actual cost",
  },
  /** A cap's kind (`cap.kind`): its field name is `kind` like a deadline's, so it has its own key. */
  capKind: {
    none: "No limit",
    count: "A number of times at most",
    amount: "A total amount at most",
    ratio_to_randomized: "A number for each randomized subject",
    blocks_with_reauth: "A number at a time, then the sponsor approves more",
  },
  kind: {
    invoice_days_from_expense: "Invoice within N days of expense",
    invoice_months_after_study_close: "Invoice within N months of study close",
    final_invoice_days_after_closeout: "Final invoice within N days of closeout",
    query_resolution_days: "Resolve queries within N days",
    dispute_days_after_final_payment: "Dispute within N days of final payment",
    edc_entry_business_days: "EDC entry within N business days",
  },
};

/** What each audit-log action is called on the Activity page; searching the log matches these words too. */
export const ACTION_LABELS: Record<string, string> = {
  "study.created": "Contract added",
  "study.identified": "Files sorted",
  "study.confirmed": "Details confirmed",
  "document.uploaded": "File uploaded",
  "document.kind_changed": "File kind changed",
  "document.kind_set": "File kind changed",
  "amendment.uploaded": "Amendment uploaded",
  "extraction.queued": "Reading started",
  "extraction.succeeded": "Read and checked",
  "extraction.completed": "Read and checked",
  "extraction.failed": "Couldn't read",
  "review.answered": "Question answered",
  "review.changed": "Answer changed",
  "review.sent_back": "Answers sent back",
  "review.reopened": "Total asked again",
  "review.closed": "Question closed",
  "review.table_confirmed": "Table's columns confirmed",
  "review.table_rejected": "Table's columns rejected",
  "review.blank_removed": "Blank table cells removed",
  "review.blank_rejected": "Blank table cells sent to be typed",
  "sample.missed": "Spot check found a wrong number",
  "value.corrected": "Value corrected",
  "anomaly.resolved": "Problem settled",
  "grid.chosen": "Budget grid chosen",
  "version.manual_created": "Started typing by hand",
  "value.typed": "Typed by hand",
  "byhand.done": "Done typing",
  "number.reported": "Reported a number",
  "value.reported": "Reported a value",
  "version.correction_opened": "Correction started",
  "version.corrections_carried": "Corrections carried over",
  "version.signed": "Approved",
  "version.exported": "Exported",
  "master.exported": "Exported",
  "values.proofread": "Proofread",
  "budget.checked": "Budget spreadsheet checked",
  "settings.updated": "Settings changed",
};
/** "review.sent_back" → "Answers sent back"; an action without a label reads as its words. */
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Why an upload isn't taken, in plain words (ADR-003 P1), for the API and the upload screen alike: a
 * spreadsheet or a Word file says what to upload instead; anything else that isn't a PDF says so.
 * A budget spreadsheet isn't a contract document: it's checked against the read (`budgetCheck`, POST …/budget-check).
 */
export const notAPdfWords = (name: string) =>
  /\.(?:xlsx|xlsm|xls|csv)$/i.test(name) ? `${name} is a spreadsheet. Upload the signed contract PDF here; once it's read, you can check its budget against this spreadsheet.`
  : /\.(?:docx?|rtf|odt)$/i.test(name) ? `${name} is a Word document, not the signed contract. Upload the signed contract PDF (the DocuSign copy).`
  : `${name} is not a PDF`;

/** A long PDF with text but no amounts anywhere: a lab manual or a reference, never billed from, so never read (ADR-003 P1). */
export const notAContractWords = (name: string, pages: number) =>
  `${name} has ${pages} pages and no amounts in it: it looks like a manual or a reference document, not a contract, so nothing in it is billed. Leave it out.`;

/** A PDF with no text in it: a printed copy or a scan. Read anyway, from pictures; the signed original reads exactly (ADR-003 P1). */
export const PRINTED_COPY_WORDS =
  "This PDF has no text in it: it's a printed copy or a scan, so its numbers are read from a picture and more of them come to you to check. If you have the signed original (the DocuSign PDF the sponsor sent), upload that instead: its numbers are read exactly. You can also go ahead with this one.";
