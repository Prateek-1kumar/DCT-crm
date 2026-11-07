"use client";

import type { Term } from "@dct/shared";
import type { TabProps } from "./model";
import { TermTable } from "./TermTable";

const FEE_CATEGORIES: Term["category"][] = ["site_fee", "recurring_fee", "invoiceable", "conditional_procedure", "unscheduled_visit", "screen_failure", "stipend_travel", "bonus"];

/** "Fees & invoiceables": everything the site is paid outside the visit grid, or has to invoice for. */
export function FeesTab(props: TabProps) {
  return <TermTable {...props} categories={FEE_CATEGORIES} title="Fees and items you invoice" emptyTitle="No fees found in this contract" emptyText="The contract names no one-time fees, recurring fees, extra procedures, stipends or bonuses." />;
}
