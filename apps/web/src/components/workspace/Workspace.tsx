"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ComponentType } from "react";
import { useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { stepInfo } from "@/lib/steps";
import { Documents } from "../study/Documents";
import { studySub, studyTitle } from "../study/format";
import { ReadingPanel } from "../study/ReadingPanel";
import { Skeleton } from "../study/Skeleton";
import { HistoryTab } from "../activity";
import { ContractSidePanel } from "../contract";
import { ContractParties } from "../parties";
import { OverviewTab } from "../overview";
import { encodeRef } from "../proof/model";
import { BudgetGridTab, FeesTab, PaymentTermsTab, type ShowRef, type TabProps } from "../rulebook";
import { Badge, cx, Empty, errorText, inputBase, LoadError, onTabKeys, pageCls } from "../ui";
import { useVersion } from "../version/useVersion";
import { StatusBanner } from "./Banner";
import { Stepper } from "./Stepper";
import { VersionPicker } from "./VersionPicker";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "grid", label: "Budget grid" },
  { id: "fees", label: "Fees & invoiceables" },
  { id: "terms", label: "Payment terms" },
  { id: "documents", label: "Documents" },
  { id: "history", label: "History" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// only the overview has the Proofread button, so the others ignore the extra prop
const PANEL: Record<Exclude<TabId, "documents" | "history">, ComponentType<TabProps & { onOpenProofread?: () => void }>> = { overview: OverviewTab, grid: BudgetGridTab, fees: FeesTab, terms: PaymentTermsTab };

// Export stays off until the backend can produce it.
const SHOW_EXPORT = false;

function VersionPanel({ versionId, tab, query }: { versionId: string; tab: Exclude<TabId, "documents" | "history">; query: string }) {
  const me = useActingAs();
  const router = useRouter();
  const client = useQueryClient();
  const [target, setTarget] = useState<ShowRef | null>(null);
  const v = useVersion(versionId);
  // the coverage is only for the overview's "how the numbers were checked" panel and the grid's doubtful cells
  const coverage = useQuery({ queryKey: keys.coverage(versionId), queryFn: () => api.coverage(versionId), enabled: !!v.data?.rulebook });
  const proofread = useMutation({
    mutationFn: ({ items, mark }: { items: string[]; mark: boolean }) => (mark ? api.proofread(versionId, me!, items) : Promise.all(items.map((item) => api.unproofread(versionId, me!, item))).then((all) => all.at(-1)!)),
    onSuccess: (updated) => client.setQueryData(keys.version(versionId), updated),
  });
  if (v.isPending) return <Skeleton className="h-40 w-full rounded-card" />;
  if (v.isError) return <LoadError error={v.error} retry={() => void v.refetch()} what="this version" back={{ href: "/", label: "Back to contracts" }} />;
  if (!v.data.rulebook) return <Empty title="Nothing to show yet">This version has no rulebook.</Empty>;
  const Panel = PANEL[tab];
  const proofUrl = (ref?: ShowRef) => `/versions/${versionId}/proof${ref ? `?ref=${encodeRef(ref)}` : ""}`;
  return (
    <>
      {proofread.isError && <p role="alert" className="mb-3 text-body text-danger">{errorText(proofread.error)}</p>}
      <Panel
        version={v.data}
        coverage={coverage.data}
        query={query}
        me={me}
        onShow={setTarget}
        onProofread={(items, mark) => proofread.mutate({ items, mark })}
        onOpenProofread={() => router.push(proofUrl())}
      />
      <ContractSidePanel version={v.data} target={target} onClose={() => setTarget(null)} onOpenFull={() => router.push(proofUrl(target ?? undefined))} />
    </>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className={pageCls} aria-label="Loading this contract">
      <Skeleton className="h-7 w-72" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      <Skeleton className="mt-10 h-16 w-full rounded-card" />
      <Skeleton className="mt-6 h-24 w-full rounded-card" />
      <Skeleton className="mt-6 h-56 w-full rounded-card" />
    </div>
  );
}

export function Workspace({ id }: { id: string }) {
  const me = useActingAs();
  const study = useQuery({ queryKey: keys.study(id), queryFn: () => api.study(id) });
  const studies = useQuery({ queryKey: keys.studies, queryFn: api.studies });
  const asked = useSearchParams().get("tab");
  const [tab, setTab] = useState<TabId | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  if (study.isError) return <LoadError error={study.error} retry={() => void study.refetch()} />;
  if (studies.isError) return <LoadError error={studies.error} retry={() => void studies.refetch()} />;
  if (!study.data || !studies.data) return <WorkspaceSkeleton />;

  const s = study.data;
  const row = studies.data.find((r) => r.id === id);
  if (!row) return <LoadError error="We couldn't find this contract in your list. Go back to the contracts and open it again." what="this contract" />;

  const info = stepInfo(row, me);
  const ready = s.versions.filter((v) => v.status === "draft" || v.status === "approved" || v.status === "superseded").sort((a, b) => b.number - a.number);
  const versionId = picked && ready.some((v) => v.id === picked) ? picked : ready[0]?.id;
  const latest = s.versions.reduce<(typeof s.versions)[number] | undefined>((a, v) => (!a || v.number > a.number ? v : a), undefined);
  // Opens where the person is needed: the files when there are none, otherwise the rulebook.
  const first: TabId = TABS.some((t) => t.id === asked) ? (asked as TabId) : info.phase === "add" ? "documents" : "overview";
  const active = tab ?? first;
  const title = studyTitle(s.protocol, s.documents[0]?.name);
  const sub = studySub(s.protocol, [row.pi]);

  return (
    <div className={pageCls}>
      <Link href="/" className="text-small font-medium text-accent hover:text-accent-hover">
        ← Contracts
      </Link>
      <header className="mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1 basis-[320px]">
          <div className="flex items-center gap-3">
            <h1 title={title} className="min-w-0 truncate text-display font-semibold tracking-[-0.025em]">
              {title}
            </h1>
            {info.newVersion && <Badge tone="accent" className="shrink-0">New version in progress</Badge>}
          </div>
          <p title={sub} className="mt-1 truncate text-lead text-muted">
            {sub}
          </p>
          <ContractParties study={s} />
        </div>
        <div className="flex w-full items-center gap-2.5 sm:w-auto">
          <label className="relative block min-w-0 flex-1 sm:w-[280px] sm:flex-none">
            <span className="sr-only">Search this contract</span>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this contract" className={cx(inputBase, "w-full pl-10")} />
          </label>
          {/* COMPONENT: Export button; hidden until the backend has an export. */}
          {SHOW_EXPORT && <button type="button">Export</button>}
        </div>
      </header>

      <div className="mt-8 flex flex-col gap-6">
        <Stepper info={info} />
        <StatusBanner row={row} info={info} onAddFiles={() => setTab("documents")} />
        {latest && (latest.status === "reading" || latest.status === "failed") && <ReadingPanel studyId={id} version={latest} />}
      </div>

      <div className="mt-8 flex flex-col gap-5">
        {versionId && <VersionPicker versions={ready} value={versionId} onChange={setPicked} />}
        <div role="tablist" aria-label="This contract" onKeyDown={onTabKeys} className="flex gap-6 overflow-x-auto border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={t.id === active}
              aria-controls="tab-panel"
              tabIndex={t.id === active ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={cx("inline-flex h-11 items-center border-b-2 text-body font-medium whitespace-nowrap", t.id === active ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink")}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="tab-panel" aria-labelledby={`tab-${active}`} className="min-w-0">
          {active === "documents" ? (
            <Documents study={s} />
          ) : active === "history" ? (
            <HistoryTab studyId={id} />
          ) : versionId ? (
            <VersionPanel key={versionId} versionId={versionId} tab={active} query={query} />
          ) : (
            <Empty title="Nothing to show yet">The rulebook appears here once the contract has been read.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}
