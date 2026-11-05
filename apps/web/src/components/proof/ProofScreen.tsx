"use client";

import { useQuery } from "@tanstack/react-query";
import { api, keys } from "@/lib/queries";
import { Empty, LoadError, onTabKeys, pageCls, Spinner, cx } from "../ui";
import { ContractTab } from "./ContractTab";
import { buildProof, locate, type Spot } from "./model";
import { RulebookTab } from "./RulebookTab";
import { useProofUrl, type Tab } from "./useProofUrl";

const TABS: { id: Tab; label: string }[] = [
  { id: "contract", label: "Contract" },
  { id: "rulebook", label: "Rulebook" },
];

export function ProofScreen({ versionId }: { versionId: string }) {
  const version = useQuery({ queryKey: keys.version(versionId), queryFn: () => api.version(versionId) });
  const coverage = useQuery({ queryKey: keys.coverage(versionId), queryFn: () => api.coverage(versionId) });
  const { url, set } = useProofUrl();

  const error = version.error ?? coverage.error;
  if (error) return <LoadError error={error} what="the proof" retry={() => void Promise.all([version.refetch(), coverage.refetch()])} />;
  if (!version.data || !coverage.data) {
    return (
      <div className="p-8">
        <Spinner label="Loading the proof" />
      </div>
    );
  }
  const data = buildProof(version.data, coverage.data);
  if (!data) {
    return (
      <div className={pageCls}>
        <Empty title="Nothing to check yet">The contract is still being read. The proof appears here once the rulebook is drafted.</Empty>
      </div>
    );
  }

  const spot: Spot | null = url.doc && url.page ? { doc: url.doc, page: url.page, box: url.box } : url.ref ? locate(data, url.ref) : null;

  return (
    <div className={pageCls}>
      <div role="tablist" aria-label="Proof views" onKeyDown={onTabKeys} className="mb-6 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`proof-tab-${t.id}`}
            aria-selected={url.tab === t.id}
            aria-controls="proof-panel"
            tabIndex={url.tab === t.id ? 0 : -1}
            onClick={() => set({ tab: t.id }, true)}
            className={cx("-mb-px border-b-2 px-4 py-2 text-body font-medium", url.tab === t.id ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="proof-panel" aria-labelledby={`proof-tab-${url.tab}`}>
        {url.tab === "contract" ? (
          <ContractTab
            data={data}
            spot={spot}
            line={url.ref}
            onSelect={({ ref, doc, page, box }) => set({ ref, doc, page, box })}
            onShowInRulebook={() => set({ tab: "rulebook" }, true)}
          />
        ) : (
          <RulebookTab
            data={data}
            line={url.ref}
            onSelect={(ref) => set({ ref, doc: null, page: null, box: null })}
            onShowOnContract={() => set({ tab: "contract" }, true)}
          />
        )}
      </div>
    </div>
  );
}
