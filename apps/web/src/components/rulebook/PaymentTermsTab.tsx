"use client";

import type { TabProps } from "./model";
import { TermTable } from "./TermTable";
import { PAYMENT_CATEGORIES } from "./terms";


export function PaymentTermsTab(props: TabProps) {
  return <TermTable {...props} categories={PAYMENT_CATEGORIES} title="Payment terms and rules" emptyTitle="No payment terms found in this contract" emptyText="The contract names no payment schedule, invoicing rule, holdback, overhead, deadline or limit." />;
}
