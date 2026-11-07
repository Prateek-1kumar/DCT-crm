import type { Coverage } from "@/lib/types";
import { Button, cx } from "../ui";
import { plural } from "./model";

function Tile({ label, n, tone }: { label: string; n: number; tone?: string }) {
  return (
    <div className="rounded-tile bg-sunken px-4 py-3">
      <p className={cx("num text-heading font-semibold", tone)}>{n.toLocaleString("en-US")}</p>
      <p className="text-small text-muted">{label}</p>
    </div>
  );
}

/** How every dollar amount printed in the contract ended up, from the coverage check. */
export function TotalsBar({ totals, scanned, onNext }: { totals: Coverage["totals"]; scanned: number; onNext: () => void }) {
  return (
    <section aria-label="How the amounts were checked" className="grid gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Matched the PDF" n={totals.captured} tone="text-ok" />
        <Tile label="Confirmed by a person" n={totals.decided} tone="text-info" />
        <Tile label="Set aside on purpose" n={totals.setAside} />
        <Tile label="Missing from the rulebook" n={totals.missing} tone={totals.missing ? "text-danger" : undefined} />
      </div>
      {totals.missing > 0 ? (
        <p role="alert" className="flex flex-wrap items-center gap-3 rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
          {plural(totals.missing, "amount")} printed in the contract {totals.missing === 1 ? "isn't" : "aren't"} in the rulebook yet. This needs a look before approval.
          <Button variant="danger" size="sm" onClick={onNext}>
            Next missing
          </Button>
        </p>
      ) : (
        <p className="rounded-field bg-ok-soft px-4 py-3 text-body text-ok">Nothing missing: every amount we could read in the contract is in the rulebook.</p>
      )}
      {scanned > 0 && (
        <p className="rounded-field bg-warn-soft px-4 py-3 text-body text-warn">
          {plural(scanned, "page")} in this contract {scanned === 1 ? "is" : "are"} scanned: amounts on {scanned === 1 ? "it" : "them"} can&apos;t be checked.
        </p>
      )}
    </section>
  );
}
