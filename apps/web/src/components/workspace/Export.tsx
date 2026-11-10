"use client";

import { Download, Printer } from "lucide-react";
import { useState } from "react";
import { downloadCsv, type CsvCell } from "@/lib/csv";
import { allActivity } from "@/lib/queries";
import type { Study } from "@/lib/types";
import { activityRows, documentRows, exportHead, exportName, gridsRows, section, termRows } from "../rulebook/export";
import { FEE_CATEGORIES, PAYMENT_CATEGORIES } from "../rulebook/terms";
import { Button, errorText } from "../ui";
import { useVersion } from "../version/useVersion";

export type ExportWhat = "overview" | "grid" | "fees" | "terms" | "documents" | "history" | "all";

const NAME: Record<ExportWhat, string> = { overview: "all terms", grid: "budget grid", fees: "fees and invoiceables", terms: "payment terms", documents: "documents", history: "history", all: "rulebook" };

/**
 * "Export CSV" and "Print or save as PDF" for one tab, or for the whole contract (`what: "all"`). The CSV is built here from
 * what is already loaded; the PDF is the browser's own print, which the caller sets the page up for.
 */
export function ExportButtons({ what, study, title, versionId, onPrint }: { what: ExportWhat; study: Study; title: string; versionId: string | undefined; onPrint: () => void }) {
  // the same query the tabs use, so this asks the server for nothing new
  const v = useVersion(versionId ?? "", !!versionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = v.data;
  const needsRulebook = what !== "documents" && what !== "history";
  const ready = !needsRulebook || !!version?.rulebook;

  async function rows(): Promise<CsvCell[][]> {
    const terms = version?.rulebook?.terms ?? [];
    const fees = () => termRows(version!, terms.filter((t) => FEE_CATEGORIES.includes(t.category)));
    const payment = () => termRows(version!, terms.filter((t) => PAYMENT_CATEGORIES.includes(t.category)));
    const history = async () => activityRows(await allActivity({ study: study.id }), false);
    switch (what) {
      case "overview":
        return termRows(version!, terms);
      case "grid":
        return gridsRows(version!);
      case "fees":
        return fees();
      case "terms":
        return payment();
      case "documents":
        return documentRows(study);
      case "history":
        return history();
      case "all":
        return [...section("Budget grid", gridsRows(version!)), ...section("Fees and invoiceables", fees()), ...section("Payment terms", payment()), ...section("Documents", documentRows(study)), ...section("History", await history())];
    }
  }

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      const marked = needsRulebook && version ? version : null;
      downloadCsv(exportName(title, NAME[what], marked), [...exportHead(title, marked), ...(await rows())]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const all = what === "all";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error && <p role="alert" className="text-small text-danger">{error}</p>}
      <Button size="sm" variant={all ? "secondary" : "ghost"} disabled={!ready || busy} title={ready ? undefined : "There is nothing to export until the contract has been read."} onClick={() => void exportCsv()}>
        <Download aria-hidden className="size-4" strokeWidth={1.75} />
        {busy ? "Preparing…" : all ? "Export all (CSV)" : "Export CSV"}
      </Button>
      <Button size="sm" variant={all ? "secondary" : "ghost"} disabled={!ready} title="Opens your browser's print window. Choose “Save as PDF” there to get a PDF." onClick={onPrint}>
        <Printer aria-hidden className="size-4" strokeWidth={1.75} />
        {all ? "Print all or save PDF" : "Print or save PDF"}
      </Button>
    </div>
  );
}
