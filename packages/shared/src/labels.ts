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
  kind: {
    invoice_days_from_expense: "Invoice within N days of expense",
    invoice_months_after_study_close: "Invoice within N months of study close",
    final_invoice_days_after_closeout: "Final invoice within N days of closeout",
    query_resolution_days: "Resolve queries within N days",
    dispute_days_after_final_payment: "Dispute within N days of final payment",
    edc_entry_business_days: "EDC entry within N business days",
  },
};
