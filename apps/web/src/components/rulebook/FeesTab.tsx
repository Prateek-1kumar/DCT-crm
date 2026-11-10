"use client";

import type { TabProps } from "./model";
import { TermTable } from "./TermTable";
import { FEE_CATEGORIES } from "./terms";


/** "Fees & invoiceables": everything the site is paid outside the visit grid, or has to invoice for. */
export function FeesTab(props: TabProps) {
  return <TermTable {...props} categories={FEE_CATEGORIES} title="Fees and items you invoice" emptyTitle="No fees found in this contract" emptyText="The contract names no one-time fees, recurring fees, extra procedures, stipends or bonuses." />;
}
