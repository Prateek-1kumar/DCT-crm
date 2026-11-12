"use client";

import type { Term } from "@dct/shared";
import { Badge, Card, CopyButton, Empty } from "@/components/ui";
import { plainAmount } from "@/lib/money";
import { attentionFirst, proofreaders, termMatches, termsNeedingDecision, type TabProps } from "./model";
import { DecisionPill, ProofBadge, ProofreadControl, ShowLink } from "./parts";
import { BILLING_SHORT, capText, CATEGORY_LABEL, termMoney } from "./terms";

const head = "px-4 py-3 text-left font-medium align-bottom";
const cell = "px-4 py-3 align-top break-words";

/**
 * A table of terms in the given categories. It scrolls inside its own box so a narrow screen never scrolls the page, and
 * the first column stays put. `emptyTitle`/`emptyText` say what "nothing here" means for this tab.
 */
export function TermTable({ categories, title, emptyTitle, emptyText, version, query, unreadOnly, me, onShow, onProofread }: TabProps & { categories: Term["category"][]; title: string; emptyTitle: string; emptyText: string }) {
  const rulebook = version.rulebook;
  if (!rulebook) return <Empty title="Nothing to show yet">The rulebook appears here once the contract has been read.</Empty>;

  const all = rulebook.terms.filter((t) => categories.includes(t.category));
  if (!all.length) return <Empty title={emptyTitle}>{emptyText}</Empty>;

  const decision = termsNeedingDecision(rulebook);
  const unread = all.filter((t) => !unreadOnly || proofreaders(version, t.id).length === 0);
  if (!unread.length) return <Empty title="Everything here has been proofread">Untick “Not proofread yet” to see it all again.</Empty>;
  const rows = attentionFirst(unread.filter((t) => termMatches(t, query)), decision);
  if (!rows.length) return <Empty title={`Nothing matches “${query.trim()}”`}>Try a different word or amount, or clear the search.</Empty>;

  return (
    <Card className="overflow-hidden print:overflow-visible print:shadow-none">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-5 pb-3 sm:px-6">
        <h2 className="text-title font-semibold tracking-tight">{title}</h2>
        <p className="text-small text-muted">{rows.length === 1 ? "1 item" : `${rows.length} items`}</p>
      </div>
      {/* relative: keeps the screen-reader-only header text inside this scroll box, so it can't stretch the page */}
      <div className="relative overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[960px] border-t border-line text-body print:min-w-0 print:text-[9px]">
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
                    <span className="mt-1.5 block">
                      {/* tabs between the fields, so a paste into a spreadsheet lands in separate cells */}
                      <CopyButton label={`Copy this row: ${t.name}`} text={[t.name, plainAmount(termMoney(t)), BILLING_SHORT[t.billing], t.trigger ?? "", (t.cap && capText(t.cap)) || "", t.deadline ?? "", `${t.source.doc}, page ${t.source.page}`].join("\t")}>
                        Copy row
                      </CopyButton>
                    </span>
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
