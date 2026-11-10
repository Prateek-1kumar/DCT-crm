"use client";

import type { Term } from "@dct/shared";
import { Badge, Card, Empty } from "@/components/ui";
import { attentionFirst, termMatches, termsNeedingDecision, type TabProps } from "./model";
import { DecisionPill, ProofBadge, ProofreadControl, ShowLink } from "./parts";
import { BILLING_SHORT, capText, CATEGORY_LABEL, termMoney } from "./terms";

const head = "px-4 py-3 text-left font-medium align-bottom";
const cell = "px-4 py-3 align-top break-words";

/**
 * A table of terms in the given categories. It scrolls inside its own box so a narrow screen never scrolls the page, and
 * the first column stays put. `emptyTitle`/`emptyText` say what "nothing here" means for this tab.
 */
export function TermTable({ categories, title, emptyTitle, emptyText, version, query, me, onShow, onProofread }: TabProps & { categories: Term["category"][]; title: string; emptyTitle: string; emptyText: string }) {
  const rulebook = version.rulebook;
  if (!rulebook) return <Empty title="Nothing to show yet">The rulebook appears here once the contract has been read.</Empty>;

  const all = rulebook.terms.filter((t) => categories.includes(t.category));
  if (!all.length) return <Empty title={emptyTitle}>{emptyText}</Empty>;

  const decision = termsNeedingDecision(rulebook);
  const rows = attentionFirst(all.filter((t) => termMatches(t, query)), decision);
  if (!rows.length) return <Empty title={`Nothing matches “${query.trim()}”`}>Try a different word or amount, or clear the search.</Empty>;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-5 pb-3 sm:px-6">
        <h2 className="text-title font-semibold tracking-tight">{title}</h2>
        <p className="text-small text-muted">{rows.length === 1 ? "1 item" : `${rows.length} items`}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] border-t border-line text-body">
          <caption className="sr-only">{title}</caption>
          <thead className="bg-sunken text-small text-muted">
            <tr>
              <th scope="col" className={`${head} sticky left-0 z-10 w-[22%] bg-sunken`}>
                Name
              </th>
              <th scope="col" className={`${head} w-[14%]`}>
                Amount or rule
              </th>
              <th scope="col" className={`${head} w-[12%]`}>
                How it&apos;s billed
              </th>
              <th scope="col" className={`${head} w-[16%]`}>
                When it applies
              </th>
              <th scope="col" className={`${head} w-[10%]`}>
                Cap
              </th>
              <th scope="col" className={`${head} w-[8%]`}>
                Deadline
              </th>
              <th scope="col" className={`${head} w-[14%]`}>
                Proof
              </th>
              <th scope="col" className={`${head} w-[4%]`}>
                <span className="sr-only">Show in the contract</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((t) => {
              const more = [t.conditions, t.holdbackApplies === "unclear" && "Not clear whether the holdback applies", t.overheadApplies === "unclear" && "Not clear how overhead applies"].filter(Boolean).join(" · ");
              return (
                <tr key={t.id}>
                  <th scope="row" className={`${cell} sticky left-0 z-10 bg-surface text-left font-normal`}>
                    <span className="block font-medium">{t.name}</span>
                    <span className="block text-small text-muted">{CATEGORY_LABEL[t.category]}</span>
                    {more && <span className="mt-1 block text-small text-muted">{more}</span>}
                    {decision.has(t.id) && (
                      <span className="mt-1.5 block">
                        <DecisionPill />
                      </span>
                    )}
                  </th>
                  <td className={`${cell} num font-medium`}>{termMoney(t) || <span className="font-normal text-muted">No amount stated</span>}</td>
                  <td className={cell}>
                    <Badge tone={t.billing === "unknown" ? "warn" : "neutral"} className="h-auto min-h-6 whitespace-normal py-0.5">
                      {BILLING_SHORT[t.billing]}
                    </Badge>
                  </td>
                  <td className={cell}>{t.trigger ?? <span className="text-faint">—</span>}</td>
                  <td className={cell}>{(t.cap && capText(t.cap)) || <span className="text-faint">—</span>}</td>
                  <td className={cell}>{t.deadline ?? <span className="text-faint">—</span>}</td>
                  <td className={cell}>
                    <div className="flex flex-col items-start gap-1.5">
                      <ProofBadge evidence={t.evidence} />
                      <ProofreadControl item={t.id} name={t.name} version={version} me={me} onProofread={onProofread} />
                    </div>
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    <ShowLink name={t.name} onClick={() => onShow({ target: "term", id: t.id })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
