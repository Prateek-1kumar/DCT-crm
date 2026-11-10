"use client";

import { useState, type Ref } from "react";
import type { CoverageAmount, Version } from "@/lib/types";
import { ProofBadge } from "../rulebook/parts";
import { Badge, cx } from "../ui";
import { ReviewActions } from "../viewer";
import { sourceText, type Claim } from "./claim";
import { DOUBT_WORDS, STATUS } from "./model";

const QUOTE_LINES_CHARS = 150;

/** One or two lines of the quote; "Show full quote" opens the rest in place. */
function Quote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > QUOTE_LINES_CHARS;
  return (
    <div className="mt-1 text-small text-ink-2">
      <p className={cx(!open && "line-clamp-2", open && "max-h-28 overflow-y-auto")}>
        <q>{text}</q>
      </p>
      {long && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="font-medium text-accent hover:text-accent-hover hover:underline">
          {open ? "Show less" : "Show full quote"}
        </button>
      )}
    </div>
  );
}

const shell = "grid shrink-0 max-h-[32%] gap-x-6 gap-y-2 overflow-y-auto rounded-tile bg-surface px-4 py-3 ring-1 ring-ink/[0.08] lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]";

/**
 * The rulebook's claim for the selected item, slim so the contract keeps the screen: its name and value, how it is proven,
 * where it was read, the quote, and (on the right) who has checked it and the buttons to check it or flag it. Conditions,
 * how it is paid, the cap and the deadline wait behind "Details".
 */
export function ClaimStrip({ claim, version, me, stripRef, itemsKey }: { claim: Claim; version: Version; me: string | null; stripRef?: Ref<HTMLElement>; itemsKey: string }) {
  return (
    <section ref={stripRef} aria-label="What the rulebook claims" className={shell}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h3 className="min-w-0 max-w-full truncate text-title font-semibold tracking-tight" title={claim.name}>
            {claim.name}
          </h3>
          <p className="num min-w-0 max-w-full truncate text-heading font-semibold" title={claim.value}>
            {claim.value}
          </p>
          {claim.evidence && <ProofBadge evidence={claim.evidence} />}
        </div>
        <p className="mt-0.5 truncate text-small text-muted" title={sourceText(claim)}>
          {sourceText(claim)}
        </p>
        {claim.quote && <Quote text={claim.quote} />}
        {claim.details.length > 0 && (
          <details className="mt-1 text-small">
            <summary className="w-fit cursor-pointer font-medium text-accent hover:text-accent-hover">Details</summary>
            <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
              {claim.details.map((d) => (
                <div key={d.label} className="contents">
                  <dt className="text-muted">{d.label}</dt>
                  <dd className="break-words text-ink-2">{d.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
      <div className="min-w-0">
        <ReviewActions key={itemsKey} compact version={version} items={claim.items} me={me} />
      </div>
    </section>
  );
}

/** A picked amount that no item of the rulebook accounts for (or one set aside on purpose): nothing to proofread, just what it is. */
export function AmountStrip({ amount }: { amount: CoverageAmount }) {
  const s = STATUS[amount.status];
  return (
    <section aria-label="What the rulebook claims" className={cx(shell, "lg:grid-cols-1")}>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="num text-heading font-semibold">{amount.text}</h3>
        <Badge tone={s.tone}>{s.proof}</Badge>
        {amount.doubt && <Badge tone="warn">{DOUBT_WORDS[amount.doubt]}</Badge>}
      </div>
      {amount.status === "missing" ? (
        <p role="alert" className="text-body text-danger">
          Not in the rulebook yet: this needs a look before approval. The contract prints {amount.text} here, but no item in the rulebook accounts for it.
        </p>
      ) : amount.status === "set_aside" ? (
        <p className="text-body text-ink-2">{amount.reason ?? "No reason was recorded."}</p>
      ) : null}
    </section>
  );
}

/** Shown when the link names an item the rulebook no longer has, or nothing at all. */
export function NoClaim({ children }: { children: string }) {
  return (
    <section aria-label="What the rulebook claims" className={cx(shell, "lg:grid-cols-1")}>
      <p className="text-body text-muted">{children}</p>
    </section>
  );
}
