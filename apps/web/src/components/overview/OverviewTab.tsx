"use client";

import { Badge, Button, Card, cx, Empty } from "@/components/ui";
import type { Coverage, Version } from "@/lib/types";
import type { TabProps } from "../rulebook/model";
import { DecisionPill, ProofBadge, ProofreadControl, ShowLink } from "../rulebook/parts";
import { buildOverview, flagPill, proofreadCounts, type CardFlag, type CardModel } from "./model";

/** Reviewers' "something looks wrong" on a card: the first note short, the rest counted, all of it in the title. Only a record: it never blocks approval. */
export function FlagPill({ flags }: { flags: CardFlag[] }) {
  const pill = flagPill(flags);
  if (!pill) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" title={pill.title}>
      <Badge tone="warn" className="h-auto min-h-6 max-w-full py-0.5 whitespace-normal">
        <span className="break-words">{pill.text}</span>
      </Badge>
      {pill.more > 0 && <span className="text-small font-medium text-warn">+{pill.more} more</span>}
    </div>
  );
}

function OverviewCard({ card, version, me, onShow, onProofread }: { card: CardModel } & Pick<TabProps, "version" | "me" | "onShow" | "onProofread">) {
  const title = card.term?.name ?? card.label;
  return (
    <li className={cx("flex min-w-0 flex-col gap-2 rounded-tile p-5 ring-1", card.muted ? "bg-sunken text-muted ring-line" : "bg-surface shadow-card ring-ink/[0.05]", card.attention && !card.muted && "ring-warn/40")}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-small font-medium text-muted">{card.label}</p>
        {card.needsDecision && <DecisionPill />}
      </div>
      {card.term && <h3 className="text-body font-medium break-words">{card.term.name}</h3>}
      <p className={cx("num font-semibold tracking-tight break-words", card.muted ? "text-title text-muted" : "text-heading text-ink")}>{card.value}</p>
      {card.detail && <p className="text-small text-ink-2 break-words">{card.detail}</p>}
      {card.evidence && (
        <div>
          <ProofBadge evidence={card.evidence} />
        </div>
      )}
      <FlagPill flags={card.flags} />
      <div className="mt-auto flex flex-col gap-1.5 pt-1">
        {card.termId && <ProofreadControl item={card.termId} name={title} version={version} me={me} onProofread={onProofread} />}
        {card.show && <ShowLink name={title} onClick={() => onShow(card.show!)} />}
      </div>
    </li>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function Tile({ label, n, tone }: { label: string; n: number; tone?: string }) {
  return (
    <div className="rounded-tile bg-sunken px-4 py-3">
      <p className={cx("num text-heading font-semibold", tone)}>{n.toLocaleString("en-US")}</p>
      <p className="text-small text-muted">{label}</p>
    </div>
  );
}

export function CheckPanel({ version, coverage, onOpenProofread }: { version: Version; coverage?: Coverage; onOpenProofread?: () => void }) {
  const counts = proofreadCounts(version);
  const t = coverage?.totals;
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-title font-semibold tracking-tight">How the numbers were checked</h2>
          <p className="mt-1 max-w-[68ch] text-body text-muted">
            {!t
              ? "The check of every dollar amount against the contract isn't ready yet."
              : t.missing === 0
                ? `All ${plural(t.amounts, "dollar amount")} printed in the contract are accounted for.`
                : `${plural(t.missing, "dollar amount")} printed in the contract ${t.missing === 1 ? "isn't" : "aren't"} in the rulebook yet.`}
          </p>
        </div>
        {/* COMPONENT: opens the full side-by-side proofreading view; the manager wires onOpenProofread. */}
        <Button variant="primary" onClick={onOpenProofread} disabled={!onOpenProofread}>
          Proofread
        </Button>
      </div>
      {t && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Tile label="Matched the contract" n={t.captured} tone="text-ok" />
          <Tile label="Confirmed by a person" n={t.decided} tone="text-info" />
          <Tile label="Set aside on purpose" n={t.setAside} />
          <Tile label="Missing from the rulebook" n={t.missing} tone={t.missing ? "text-danger" : undefined} />
          <Tile label="Flagged by reviewers" n={counts.flagged} tone={counts.flagged ? "text-warn" : undefined} />
        </div>
      )}
      <p className="mt-4 text-body text-ink-2">
        {counts.terms} of {plural(counts.termsTotal, "term")} proofread by a person
        {counts.cells > 0 && `, and ${plural(counts.cells, "budget cell")}`}.
        {!t && counts.flagged > 0 && ` ${plural(counts.flagged, "item")} flagged by reviewers.`}
      </p>
    </Card>
  );
}

export function OverviewTab({ version, coverage, query, me, onShow, onProofread, onOpenProofread }: TabProps & { onOpenProofread?: () => void }) {
  if (!version.rulebook) return <Empty title="Nothing to show yet">The rulebook appears here once the contract has been read.</Empty>;
  const sections = buildOverview(version, query);
  return (
    <div className="grid min-w-0 gap-8">
      {sections.length === 0 ? (
        <Empty title={`Nothing matches “${query.trim()}”`}>Try a different word or amount, or clear the search.</Empty>
      ) : (
        sections.map((s) => (
          <section key={s.key} aria-labelledby={`ov-${s.key}`}>
            <h2 id={`ov-${s.key}`} className="mb-3 flex items-baseline gap-2 text-title font-semibold tracking-tight">
              {s.title}
              <span className="text-body font-normal text-muted">{s.cards.length}</span>
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {s.cards.map((c) => (
                <OverviewCard key={c.key} card={c} version={version} me={me} onShow={onShow} onProofread={onProofread} />
              ))}
            </ul>
          </section>
        ))
      )}
      <CheckPanel version={version} coverage={coverage} onOpenProofread={onOpenProofread} />
    </div>
  );
}
