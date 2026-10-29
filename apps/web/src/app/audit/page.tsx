"use client";

import { actionLabel, type AuditEntryDto, type StudySummaryDto } from "@dct/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type KeyboardEvent } from "react";
import { Button, Card, Empty, ErrorNote, LoadError, PageTitle, pageCls, Spinner, cx, inputBase } from "@/components/ui";
import { api } from "@/lib/api";
import { DOC_KIND_LABEL, formatDate, formatDateTime, formatValue, labelFor } from "@/lib/format";
import { keys, useAuditPages, useDebounced } from "@/lib/queries";

const contractName = (s: Pick<StudySummaryDto, "sponsor" | "protocol">) => [s.sponsor ?? "Study", s.protocol].filter(Boolean).join(" ");

/**
 * Ids and internals, meaningless to a reader: the question's wording, the file's name or the value's label is logged
 * next to them. `by` is the Who column; `path` is shown as the value's label.
 */
const UNSHOWN = new Set(["itemId", "itemIds", "documentId", "documentIds", "addedDocumentIds", "jobId", "sha256", "gridId", "grid", "path", "by", "byHand"]);
/** What each detail is called. One not here reads as its words ("pageCount" → "Page count"). */
const DETAIL: Record<string, string> = {
  before: "Before", after: "After", note: "Note", question: "Question", outcome: "Answer", version: "Version", seededFromVersion: "Copied from version",
  file: "File", filename: "File", pageCount: "Pages", text: "PDF", documents: "Files", documentKinds: "Files", format: "Format", questions: "Questions",
  anomalies: "Contract problems", pdfCheck: "Checked against the PDF", costUsd: "Reading cost", error: "Problem", typed: "Values typed",
  "re-type": "To re-type blind", values: "Values", items: "Rows", appliesFrom: "Applies from", carried: "Carried over", skipped: "Not carried over",
  studyGuess: "Found on the cover pages", sponsor: "Sponsor", protocol: "Protocol", siteName: "Site", site: "Site", investigator: "Principal investigator",
  makerChecker: "A second person approves", people: "People",
};
const OUTCOME: Record<string, string> = { matched: "Matched", differs: "Differs from the reading", "cant tell": "Can't tell", chosen: "Picked" };
const SKIPPED: Record<string, string> = { amendment_changed: "the amendment changed it", item_moved: "its row moved", path_missing: "no longer in the contract", invalid: "no longer fits", already_equal: "already the same" };
const nameOf = (k: string) => DETAIL[k] ?? k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (m) => m.toLowerCase());
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One detail in words: amounts by the value they're about (`path`), objects as "field: value", never raw data. */
function plain(v: unknown, path = ""): string {
  if (v === null || v === undefined || v === "") return path ? formatValue(path, null) : "—";
  if (Array.isArray(v)) return v.length ? v.map((x) => plain(x, path)).join(isObj(v[0]) ? "; " : ", ") : "None";
  if (isObj(v)) {
    // A carried or skipped correction: which value, and what it became (left out while its question is open).
    if (typeof v.path === "string")
      return [labelFor(v.path, null), "after" in v ? `: ${plain(v.before, v.path)} → ${plain(v.after, v.path)}` : "", typeof v.reason === "string" ? ` (${SKIPPED[v.reason] ?? v.reason})` : ""].join("");
    return Object.entries(v).filter(([k, x]) => !UNSHOWN.has(k) && x !== null && x !== undefined).map(([k, x]) => `${nameOf(k)}: ${plain(x)}`).join(" · ");
  }
  if (path) return formatValue(path, v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-US");
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? formatDate(String(v)) : String(v);
}

/** An entry's details as [what, words], and the value it's about by its label. */
function details(action: string, d: Record<string, unknown>): { about: string | null; rows: [string, string][] } {
  const path = typeof d.path === "string" ? d.path : "";
  // value.typed and *.reported log the value's label (with its row's name) as `value`; an answer's question names it.
  const about = !path || typeof d.question === "string" ? null : typeof d.value === "string" ? d.value : labelFor(path, null);
  const kind = (v: unknown) => (typeof v === "string" && v in DOC_KIND_LABEL ? DOC_KIND_LABEL[v as keyof typeof DOC_KIND_LABEL] : plain(v));
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(d)) {
    if (UNSHOWN.has(k) || (k === "value" && path) || ((k === "note" || k === "appliesFrom") && (v === null || v === ""))) continue;
    if (k === "items" && Array.isArray(v)) continue; // the rows an answer passed through, by their ids
    if ((k === "before" || k === "after") && isObj(d.before) && isObj(d.after)) {
      // Details or settings changed: each field that changed, once.
      if (k === "after") continue;
      const [b, a] = [d.before, d.after];
      for (const f of new Set([...Object.keys(b), ...Object.keys(a)]))
        if (!UNSHOWN.has(f) && JSON.stringify(b[f] ?? null) !== JSON.stringify(a[f] ?? null)) rows.push([nameOf(f), `${plain(b[f])} → ${plain(a[f])}`]);
    } else if (k === "before" || k === "after" || k === "from" || k === "to")
      rows.push([typeof v === "number" && !path ? `${nameOf(k)} version` : nameOf(k), path ? plain(v, path) : action.startsWith("document.") ? kind(v) : plain(v)]);
    else if (k === "outcome" && typeof v === "string") rows.push([nameOf(k), OUTCOME[v] ?? v]);
    else if (k === "documentKinds" && isObj(v)) rows.push([nameOf(k), Object.values(v).map(kind).join(", ")]);
    else if (k === "pdfCheck" && isObj(v)) rows.push([nameOf(k), `${plain(v.matched)} of ${plain(v.values)} numbers matched`]);
    else if (k === "costUsd" && typeof v === "number") rows.push([nameOf(k), `$${v.toFixed(2)}`]);
    else if (k === "format") rows.push([nameOf(k), v === "xlsx" ? "Excel" : plain(v)]);
    else if (k === "text") rows.push([nameOf(k), v === "text" ? "Text PDF" : v === "scan" ? "Scan" : plain(v)]);
    else rows.push([nameOf(k), plain(v)]);
  }
  return { about, rows };
}

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
  const { about, rows } = details(e.action, e.detail);
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
        {about && <p className="mb-0.5 text-xs font-medium">{about}</p>}
        <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {rows.map(([k, v], i) => (
            <div key={i} className="flex gap-1">
              <dt className="text-muted">{k}:</dt>
              <dd className={k === "Note" ? "italic" : "num"}>{v}</dd>
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
