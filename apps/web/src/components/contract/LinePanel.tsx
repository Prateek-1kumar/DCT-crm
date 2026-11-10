"use client";

import type { CoverageRef } from "@/lib/types";
import { DOUBT_WORDS, pageAt, spotFor, STATUS, type ProofData, type Spot } from "../proof/model";
import { Badge, ErrorNote } from "../ui";
import { LineSummary } from "./LineSummary";
import { LineViewer } from "./LineViewer";
import { itemsOf } from "./proofreads";
import { ProofreadMark } from "./ProofreadMark";
import { useProofread } from "./useProofread";

/**
 * Everything about one spot in the contract: what the line says, who proofread it (with the button), a note on the
 * amount you picked, and the page. Shared by the "Show in the contract" side panel and the full Proofread screen.
 * `spot` null means "the line's own page".
 */
export function LinePanel({ data, line, spot, onSpot, scrollCls }: { data: ProofData; line: CoverageRef | null; spot: Spot | null; onSpot: (spot: Spot, amountRef?: CoverageRef | null) => void; scrollCls?: string }) {
  const proofread = useProofread(data.version.id);
  const at = spot ?? (line ? spotFor(data, line) : null);
  const amount = at?.box != null ? pageAt(data, at)?.amounts[at.box] : undefined;
  const items = line ? itemsOf(data.rulebook, line) : [];
  const name = line?.target === "term" ? (data.rulebook.terms.find((t) => t.id === line.id)?.name ?? "this line") : (data.rulebook.grids.find((g) => line?.target === "grid" && g.id === line.id)?.name ?? "this budget");

  return (
    <div className="grid min-w-0 gap-4">
      {line && (
        <>
          <LineSummary data={data} line={line} />
          <ProofreadMark items={items} name={name} version={data.version} me={proofread.me} busy={proofread.busy} onProofread={proofread.run} />
          <ErrorNote error={proofread.error} />
        </>
      )}
      {amount && (
        <div aria-live="polite" className="grid gap-2 rounded-field bg-sunken px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="num text-title font-semibold">{amount.text}</span>
            <Badge tone={STATUS[amount.status].tone}>{STATUS[amount.status].proof}</Badge>
            {amount.doubt && <Badge tone="warn">{DOUBT_WORDS[amount.doubt]}</Badge>}
          </div>
          {amount.status === "missing" && (
            <p role="alert" className="text-body text-danger">
              Not in the rulebook yet: this needs a look before approval. The contract prints {amount.text} here, but no line in the rulebook accounts for it.
            </p>
          )}
          {amount.status === "set_aside" && <p className="text-body text-ink-2">{amount.reason ?? "No reason was recorded."}</p>}
        </div>
      )}
      {at ? (
        <LineViewer data={data} line={line} spot={at} onSpot={onSpot} scrollCls={scrollCls} />
      ) : (
        <p className="rounded-field bg-sunken px-4 py-6 text-center text-body text-muted">{line ? "This spot isn't on the page we have: we couldn't tell which page this line came from." : "Pick a line, or an amount on the page, to see where it is in the contract."}</p>
      )}
    </div>
  );
}
