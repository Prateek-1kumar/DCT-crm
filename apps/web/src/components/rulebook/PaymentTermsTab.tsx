"use client";

import type { Term } from "@dct/shared";
import type { TabProps } from "./model";
import { TermTable } from "./TermTable";

const PAYMENT_CATEGORIES: Term["category"][] = ["payment_terms", "invoicing", "holdback", "overhead", "deadline", "cap_or_limit", "other"];

export function PaymentTermsTab(props: TabProps) {
  return <TermTable {...props} categories={PAYMENT_CATEGORIES} title="Payment terms and rules" emptyTitle="No payment terms found in this contract" emptyText="The contract names no payment schedule, invoicing rule, holdback, overhead, deadline or limit." />;
}
