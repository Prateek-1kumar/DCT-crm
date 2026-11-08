"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Card, cx, Empty, inputBase } from "@/components/ui";
import { useMounted } from "@/lib/use-mounted";
import type { Version } from "@/lib/types";
import { buildOverview, describeItem, type CardModel } from "../overview/model";
import { encodeRef } from "../proof/model";
import { gridProofreads, proofreaders, type ShowRef } from "../rulebook/model";
import { ProofBadge } from "../rulebook/parts";
import { when } from "../study/format";
import type { KeyTerm } from "../version/key-terms";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const proofUrl = (versionId: string, ref: ShowRef) => `/versions/${versionId}/proof?tab=contract&ref=${encodeRef(ref)}`;
const linkCls = "text-small font-medium text-accent hover:text-accent-hover hover:underline";

/** Who proofread a term, or a grid's total (any cell of that grid counts). */
function proofreadNames(version: Version, ref: ShowRef | null, termId: string | null): string[] {
  if (termId) return proofreaders(version, termId);
  return ref?.target === "grid" ? gridProofreads(version, ref.id).names : [];
}

const ProofreadLine = ({ names }: { names: string[] }) => <span className="text-small text-muted">{names.length ? `Proofread by ${names.join(", ")}` : "Not proofread yet"}</span>;

/** What reviewers flagged. It is a record, never a block: nothing here changes whether Approve is enabled. */
export function FlaggedByReviewers({ version }: { version: Version }) {
  // The cache may already hold the version, so a date is drawn only after mount to keep the first render equal to the server's.
  const mounted = useMounted();
  const rulebook = version.rulebook;
  if (!rulebook || version.flags.length === 0) return null;
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title font-semibold tracking-tight">Flagged by reviewers</h2>
        <Badge tone="warn" dot>
          {plural(version.flags.length, "flag")}
        </Badge>
      </div>
      <p className="mt-2 text-body text-ink-2">These don&apos;t stop you approving. Please look at them first.</p>
      <ul className="mt-3 divide-y divide-line">
        {version.flags.map((f) => {
          const what = describeItem(rulebook, f.item);
          return (
            <li key={`${f.item}:${f.by}`} className="flex min-w-0 flex-col gap-1 py-3">
              <p className="min-w-0 font-medium break-words">
                {what ? what.name : "A line that is no longer in the rulebook"}
                {what && <span className="num font-normal text-ink-2"> · {what.value}</span>}
              </p>
              <p className="text-small text-muted">
                Flagged by {f.by}
                {mounted ? ` · ${when(f.at)}` : ""}
              </p>
              <p className="text-body break-words whitespace-pre-wrap text-ink-2">{f.note}</p>
              {what && (
                <Link href={`/versions/${version.id}/proof?ref=${encodeRef(what.ref)}`} aria-label={`Check it in the contract: ${what.name}`} className={cx(linkCls, "self-start")}>
                  Check it in the contract
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Approve is blocked while anything here exists; the Decisions screen is where it gets cleared. */
export function NeedsDecision({ version, blocking, problems }: { version: Version; blocking: { id: string; question: string }[]; problems: Version["problems"] }) {
  const n = blocking.length + problems.length;
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title font-semibold tracking-tight">Needs your decision</h2>
        <Badge tone={n ? "warn" : "ok"} dot>
          {n ? plural(n, "item") + " waiting" : "Nothing waiting"}
        </Badge>
      </div>
      {n === 0 ? (
        <p className="mt-2 text-body text-muted">Every decision is made and every check passes, so nothing stands in the way of approving.</p>
      ) : (
        <>
          <p className="mt-2 text-body text-ink-2">You can&apos;t approve this rulebook until these are sorted out.</p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-body text-ink-2">
            {blocking.map((q) => (
              <li key={q.id} className="break-words">
                {q.question}
              </li>
            ))}
            {problems.map((p, i) => (
              <li key={`p${i}`} className="break-words">
                {p.message}
              </li>
            ))}
          </ul>
          <Link href={`/versions/${version.id}/questions`} className="mt-4 inline-flex font-medium text-accent hover:text-accent-hover hover:underline">
            Go to the decisions
          </Link>
        </>
      )}
    </Card>
  );
}

function KeyTermRow({ k, version, checked, onToggle }: { k: KeyTerm; version: Version; checked: boolean; onToggle: () => void }) {
  const id = `tick-${k.id}`;
  return (
    <li className={cx("flex min-w-0 flex-col gap-2 rounded-tile bg-surface p-4 ring-1", checked ? "ring-ok/40" : "ring-ink/[0.08]")}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
          <input id={id} type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={checked} onChange={onToggle} />
          <span className="min-w-0 break-words font-medium">{k.title}</span>
        </label>
        {k.card.evidence && <ProofBadge evidence={k.card.evidence} />}
      </div>
      <div className="min-w-0 pl-7">
        <p className="num text-heading font-semibold tracking-tight break-words">{k.card.value}</p>
        {k.card.detail && <p className="text-small text-ink-2 break-words">{k.card.detail}</p>}
        <p className="mt-1 text-small text-faint">{k.why}</p>
        {k.quote && (
          <blockquote className="mt-2 line-clamp-3 border-l-2 border-line-strong pl-3 text-small text-ink-2 italic" title={k.quote}>
            {k.quote}
          </blockquote>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link href={proofUrl(version.id, k.ref)} aria-label={`Where this came from: ${k.title}`} className={linkCls}>
            Where this came from
          </Link>
          <span className="text-small text-muted">
            Page {k.page} of {k.doc}
          </span>
          <ProofreadLine names={proofreadNames(version, k.ref, k.ref.target === "term" ? k.id : null)} />
        </div>
      </div>
    </li>
  );
}

export function KeyTerms({ version, terms, ticked, onToggle }: { version: Version; terms: KeyTerm[]; ticked: Set<string>; onToggle: (id: string) => void }) {
  const left = terms.filter((k) => !ticked.has(k.id)).length;
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title font-semibold tracking-tight">Key terms to tick</h2>
        <Badge tone={left ? "warn" : "ok"}>
          <span aria-live="polite">{terms.length === 0 ? "Nothing to tick" : left ? `${left} left to tick` : "All ticked"}</span>
        </Badge>
      </div>
      <p className="mt-2 max-w-[68ch] text-body text-muted">Check each of these against the contract page, then tick it. They are the rules that move the most money.</p>
      {terms.length > 0 && (
        <ul className="mt-4 grid gap-3 lg:grid-cols-2">
          {terms.map((k) => (
            <KeyTermRow key={k.id} k={k} version={version} checked={ticked.has(k.id)} onToggle={() => onToggle(k.id)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function EverythingRow({ c, version }: { c: CardModel; version: Version }) {
  const title = c.term?.name ?? c.label;
  return (
    <li className={cx("flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3", c.muted && "text-muted")}>
      <div className="min-w-0 flex-1 basis-[240px]">
        <p className="text-small text-muted">{c.term ? `${c.label} · ${title}` : c.label}</p>
        <p className="num font-medium break-words">{c.value}</p>
        {c.detail && <p className="text-small text-ink-2 break-words">{c.detail}</p>}
      </div>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        {c.evidence && <ProofBadge evidence={c.evidence} />}
        {c.evidence && <ProofreadLine names={proofreadNames(version, c.show, c.termId)} />}
        {c.show && (
          <Link href={proofUrl(version.id, c.show)} aria-label={`Where this came from: ${title}`} className={linkCls}>
            Where this came from
          </Link>
        )}
      </div>
    </li>
  );
}

/** Every term and grid not on the tick list, grouped as the Overview groups them: closed until opened, or until a search finds something in them. */
export function Everything({ version, shown }: { version: Version; shown: Set<string> }) {
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const taken = (c: CardModel) => (c.termId && shown.has(c.termId)) || (c.key.startsWith("arm-") && shown.has(c.key.slice(4)));
  const sections = buildOverview(version, query)
    .map((s) => ({ ...s, cards: s.cards.filter((c) => !taken(c)) }))
    .filter((s) => s.cards.length);
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-title font-semibold tracking-tight">Everything else, proven</h2>
          <p className="mt-1 max-w-[68ch] text-body text-muted">The rest of the rulebook, each line with how it was proven. Open a group to look through it.</p>
        </div>
        <label className="block w-full sm:w-[260px]">
          <span className="sr-only">Search the rest of the rulebook</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the rest" className={cx(inputBase, "w-full")} />
        </label>
      </div>
      <div className="mt-4 grid gap-3">
        {sections.length === 0 ? (
          searching ? (
            <Empty title={`Nothing matches “${query.trim()}”`}>Try a different word or amount, or clear the search.</Empty>
          ) : (
            <p className="text-body text-muted">Everything in this rulebook is already on the list above.</p>
          )
        ) : (
          sections.map((s) => (
            <details key={s.key} open={searching || undefined} className="group rounded-tile bg-sunken px-4 ring-1 ring-line">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="text-faint transition-transform group-open:rotate-90">
                  ›
                </span>
                <span className="min-w-0 flex-1 break-words">{s.title}</span>
                <span className="text-body font-normal text-muted">{s.cards.length}</span>
              </summary>
              <ul className="divide-y divide-line border-t border-line">
                {s.cards.map((c) => (
                  <EverythingRow key={c.key} c={c} version={version} />
                ))}
              </ul>
            </details>
          ))
        )}
      </div>
    </Card>
  );
}
