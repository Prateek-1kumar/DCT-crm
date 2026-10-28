"use client";

import { BookOpen, CornerDownLeft, FileText, History, ListFilter, Plus, Search, Settings, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useStudies } from "@/lib/queries";
import { summaryStage, VIEWS } from "@/lib/review";
import { cx, StagePill } from "./ui";

type Entry = { id: string; group: string; label: string; sub?: string; icon: LucideIcon; right?: ReactNode; words: string; run: () => void };

/** ⌘K: jump to a contract (protocol, sponsor, site, investigator), a page, or an action. */
export function CommandPalette({ open, onClose, onGuide }: { open: boolean; onClose: () => void; onGuide: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const router = useRouter();
  const { data } = useStudies();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQ("");
      setAt(0);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const entries = useMemo(() => {
    const go = (href: string) => () => {
      onClose();
      router.push(href);
    };
    // Waiting on someone is listed first when nothing is typed.
    const waiting = new Set<string>();
    const contracts: Entry[] = (data ?? []).map((s) => {
      const st = summaryStage(s);
      if (st.stage === "Needs you" || st.stage === "Approve" || st.failed) waiting.add(`c-${s.id}`);
      return {
        id: `c-${s.id}`,
        group: "Contracts",
        label: s.protocol ?? "New contract",
        sub: [s.sponsor, s.siteName].filter(Boolean).join(" · "),
        icon: FileText,
        right: <StagePill state={st} />,
        words: [s.protocol, s.sponsor, s.siteName, s.investigator].join(" "),
        run: go(`/studies/${s.id}`),
      };
    });
    const pages: Entry[] = [
      { id: "p-all", group: "Go to", label: "All contracts", icon: FileText, words: "contracts list home", run: go("/") },
      ...VIEWS.map((v) => ({ id: `p-${v.id}`, group: "Go to", label: v.label, sub: "Contracts", icon: ListFilter, words: `contracts ${v.label}`, run: go(`/?view=${v.id}`) })),
      { id: "p-activity", group: "Go to", label: "Activity", sub: "Everything anyone did, in order", icon: History, words: "activity audit log history", run: go("/audit") },
      { id: "p-settings", group: "Go to", label: "Settings", sub: "People and approval rules", icon: Settings, words: "settings people maker checker", run: go("/settings") },
      {
        id: "p-guide",
        group: "Go to",
        label: "How it works",
        sub: "The six steps, in plain words",
        icon: BookOpen,
        words: "help guide how it works steps",
        run: () => {
          onClose();
          onGuide();
        },
      },
    ];
    const actions: Entry[] = [{ id: "a-add", group: "Actions", label: "Add a contract", sub: "Upload a signed PDF", icon: Plus, words: "add upload new contract pdf", run: go("/studies/new") }];

    const t = q.trim().toLowerCase();
    if (!t) {
      const first = contracts.filter((c) => waiting.has(c.id)).slice(0, 5).map((c) => ({ ...c, group: "Waiting on someone" }));
      return [...first, ...pages, ...actions];
    }
    const hit = (e: Entry) => t.split(/\s+/).every((w) => `${e.label} ${e.sub ?? ""} ${e.words}`.toLowerCase().includes(w));
    return [...contracts, ...pages, ...actions].filter(hit);
  }, [data, q, onClose, onGuide, router]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = entries.length;
      if (n) setAt((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      entries[at]?.run();
    }
  };

  let lastGroup = "";
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label="Search"
      className="mx-auto mt-[12vh] w-[min(640px,92vw)] overflow-hidden rounded-card bg-surface p-0 text-ink shadow-raised"
    >
      {open && (
        <div className="flex max-h-[70vh] flex-col">
          <label className="flex items-center gap-3 border-b border-line px-5">
            <Search className="size-5 shrink-0 text-muted" strokeWidth={1.75} />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setAt(0);
              }}
              onKeyDown={onKey}
              placeholder="Search contracts by protocol, sponsor or site…"
              aria-label="Search"
              className="h-16 flex-1 bg-transparent text-lead outline-none placeholder:text-faint/80"
            />
            <kbd className="rounded-md bg-ink/[0.06] px-1.5 py-0.5 font-sans text-caption text-muted">esc</kbd>
          </label>

          <ul ref={list} role="listbox" aria-label="Results" className="flex-1 overflow-y-auto p-2">
            {entries.length === 0 && (
              <li className="px-4 py-10 text-center text-body text-muted">
                Nothing matches “{q}”. Try a protocol number like NWP-418, or a sponsor name.
              </li>
            )}
            {entries.map((e, i) => {
              const heading = e.group !== lastGroup ? (lastGroup = e.group) : null;
              const Icon = e.icon;
              return (
                <li key={e.id} role="presentation">
                  {heading && <p className="eyebrow px-3 pt-3 pb-1.5">{heading}</p>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === at}
                    data-i={i}
                    onMouseMove={() => setAt(i)}
                    onClick={e.run}
                    className={cx("flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left", i === at ? "bg-brand-soft" : "")}
                  >
                    <span className={cx("grid size-9 shrink-0 place-items-center rounded-[10px]", i === at ? "bg-surface text-accent shadow-button" : "bg-sunken text-muted")}>
                      <Icon className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium">{e.label}</span>
                      {e.sub && <span className="block truncate text-small text-muted">{e.sub}</span>}
                    </span>
                    {e.right}
                    {i === at && <CornerDownLeft aria-hidden className="size-4 shrink-0 text-accent" strokeWidth={2} />}
                  </button>
                </li>
              );
            })}
          </ul>

          <footer className="flex gap-5 border-t border-line px-5 py-3 text-caption text-faint">
            <span>↑ ↓ to move</span>
            <span>↵ to open</span>
            <span>esc to close</span>
          </footer>
        </div>
      )}
    </dialog>
  );
}
