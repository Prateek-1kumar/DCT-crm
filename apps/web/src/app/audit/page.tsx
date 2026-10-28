"use client";

import { actionLabel, type AuditEntryDto, type StudySummaryDto } from "@dct/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type KeyboardEvent } from "react";
import { Button, Card, Empty, ErrorNote, LoadError, PageTitle, pageCls, Spinner, cx, inputBase } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, formatValue } from "@/lib/format";
import { keys, useAuditPages, useDebounced } from "@/lib/queries";

const contractName = (s: Pick<StudySummaryDto, "sponsor" | "protocol">) => [s.sponsor ?? "Study", s.protocol].filter(Boolean).join(" ");
/** Internal references to questions: the question's wording is logged next to them. */
const UNSHOWN = new Set(["itemId", "itemIds"]);

export default function AuditPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const studyId = sp.get("studyId") ?? undefined;
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const log = useAuditPages({ studyId, q: q || undefined });
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={pageCls}>
      <PageTitle eyebrow="Audit trail" title="Activity" sub="Everything anyone did: uploads, answers, notes and approvals. Nothing is ever removed." />
      <div className="mb-3 flex flex-wrap gap-3">
        <ContractPicker studyId={studyId} onPick={(id) => router.replace(id ? `/audit?studyId=${encodeURIComponent(id)}` : "/audit")} />
        <div className="relative w-full max-w-xs">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" strokeWidth={1.75} />
          <input type="search" aria-label="Search the log" placeholder="Search person, action, note…" className={cx(inputBase, "w-full pl-10")} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      </div>
      <p className="mb-4 text-small text-faint">While a number is waiting to be typed in, notes about it show its figures as •••, so nobody is steered. They show in full once it&apos;s answered.</p>
      {log.isPending && <Spinner />}
      {!log.data && log.error && <LoadError error={log.error} what="the activity log" retry={() => void log.refetch()} />}
      {/* a page of older entries that didn't load: what's shown stays */}
      {log.data && <ErrorNote error={log.error} retry={() => void (log.isFetchNextPageError ? log.fetchNextPage() : log.refetch())} />}
      {log.data && rows.length === 0 && (
        <Empty title={q ? "Nothing matches" : "Nothing logged yet"}>{q ? "Try fewer or other words, or look across every contract." : undefined}</Empty>
      )}
      {rows.length > 0 && (
        <Card className={cx("overflow-hidden transition-opacity", log.isPlaceholderData && "opacity-60")}>
          <table className="w-full text-[13px]">
            <thead className="bg-sunken text-left">
              <tr>
                {["When", "Who", "Contract", "What", "Details"].map((h) => (
                  <th key={h} scope="col" className="eyebrow px-4 py-2.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Row key={e.id} e={e} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {log.hasNextPage && (
        <div className="mt-5 flex justify-center">
          <Button onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
            {log.isFetchingNextPage ? "Loading…" : "Show older"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Row({ e }: { e: AuditEntryDto }) {
  return (
    <tr className="border-t border-line align-top">
      <td className="px-4 py-2.5 whitespace-nowrap text-muted">{formatDateTime(e.at)}</td>
      <td className="px-4 py-2.5 whitespace-nowrap">{e.by}</td>
      <td className="px-4 py-2.5">
        {e.studyId ? (
          <Link href={`/studies/${e.studyId}`} className="hover:text-accent hover:underline">
            {contractName(e)}
          </Link>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap">{actionLabel(e.action)}</td>
      <td className="px-4 py-2.5">
        <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {Object.entries(e.detail)
            .filter(([k]) => !UNSHOWN.has(k))
            .map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <dt className="text-muted">{k}:</dt>
                <dd className={k === "note" ? "italic" : "num"}>{formatValue(k === "before" || k === "after" ? String(e.detail.path ?? "") : k, v)}</dd>
              </div>
            ))}
        </dl>
      </td>
    </tr>
  );
}

/** Narrows the log to one contract, found by the server as you type (protocol, sponsor, site or investigator). */
function ContractPicker({ studyId, onPick }: { studyId?: string; onPick: (id: string | null) => void }) {
  const list = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim());
  const picked = useQuery({ queryKey: keys.study(studyId ?? ""), queryFn: () => api.getStudy(studyId!), enabled: !!studyId });
  const found = useQuery({
    queryKey: [...keys.studies, "pick", q],
    queryFn: () => api.listStudies({ q: q || undefined, limit: 8 }),
    enabled: open,
    placeholderData: keepPreviousData,
    select: (p) => p.items,
  });
  const options = found.data ?? [];

  if (studyId)
    return (
      <div className="flex h-10 items-center gap-1 rounded-field border border-line-strong bg-surface pr-1 pl-3.5 text-body shadow-button">
        <span className="text-muted">Contract:</span>
        <span className="max-w-[16rem] truncate font-medium">{picked.data ? contractName(picked.data) : picked.error ? "not found" : "…"}</span>
        <Button size="icon-sm" variant="ghost" aria-label="Show every contract" onClick={() => onPick(null)}>
          <X className="size-4" strokeWidth={1.75} />
        </Button>
      </div>
    );

  const choose = (s: StudySummaryDto) => {
    setOpen(false);
    setText("");
    onPick(s.id);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (options.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (e.key === "Enter" && open && options[active]) {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="relative w-72">
      <input
        role="combobox"
        aria-label="Contract"
        aria-expanded={open}
        aria-controls={list}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${list}-${active}` : undefined}
        autoComplete="off"
        placeholder="All contracts · type to find one"
        className={cx(inputBase, "w-full")}
        value={text}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKey}
      />
      {open && (
        <ul id={list} role="listbox" aria-label="Contracts" className="absolute z-30 mt-1.5 max-h-80 w-full overflow-y-auto rounded-tile bg-surface p-1 shadow-raised ring-1 ring-ink/[0.06]">
          {found.isPending && <li className="px-3 py-2 text-small text-muted">Looking…</li>}
          {found.data && !options.length && <li className="px-3 py-2 text-small text-muted">No contract matches “{q}”</li>}
          {options.map((s, i) => (
            <li
              key={s.id}
              id={`${list}-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: picking mustn't blur the box first
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cx("cursor-pointer rounded-[8px] px-3 py-2", i === active && "bg-sunken")}
            >
              <span className="block truncate text-body text-ink">{contractName(s)}</span>
              {(s.siteName || s.investigator) && <span className="block truncate text-small text-faint">{[s.siteName, s.investigator].filter(Boolean).join(" · ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
