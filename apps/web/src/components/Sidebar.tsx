"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronDown, FileText, HelpCircle, History, Menu, Search, Settings, X, type LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { askForPerson, setActingAs, useActingAs, usePersonPrompt } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { LIST_TABS, matchesQuery, tabCounts, type ListTab } from "@/lib/steps";
import { studySub, studyTitle } from "./study/format";
import { Button, cx, Dialog, inputCls, Sheet } from "./ui";

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const itemCls = (active: boolean) =>
  cx(
    "group flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-body transition-[background-color,box-shadow,color] duration-150",
    active ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2 hover:bg-ink/[0.045] hover:text-ink",
  );

const iconCls = (active: boolean) => cx("size-[17px] shrink-0 transition-colors", active ? "text-brand" : "text-muted group-hover:text-ink-2");

function NavLink({ href, label, icon: Icon, active, onNavigate }: { href: string; label: string; icon: LucideIcon; active: boolean; onNavigate?: () => void }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={itemCls(active)} onClick={onNavigate}>
      <Icon className={iconCls(active)} strokeWidth={1.75} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

/** Bottom of the sidebar: who is working. No login yet, so people give their name. */
function PersonChip() {
  const me = useActingAs();
  return (
    <button
      type="button"
      onClick={() => askForPerson()}
      className="group flex w-full items-center gap-3 rounded-[14px] p-2 text-left transition-colors hover:bg-ink/[0.045]"
    >
      <span
        aria-hidden
        className={cx(
          "grid size-9 shrink-0 place-items-center rounded-full text-small font-semibold",
          me ? "bg-brand-soft text-accent" : "border border-dashed border-warn text-warn",
        )}
      >
        {me ? initials(me) : "?"}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx("block truncate text-body font-medium", me ? "text-ink" : "text-warn")}>{me ?? "Choose your name"}</span>
        <span className="block text-caption text-faint">{me ? "Working now · switch" : "So your work is signed"}</span>
      </span>
    </button>
  );
}

/** "Who's working today?" Opens from the chip. The name is remembered in this browser only. */
function PersonPicker() {
  const open = usePersonPrompt();
  const me = useActingAs();
  const [draft, setDraft] = useState("");
  const done = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    setActingAs(name);
    setDraft("");
    askForPerson(false);
  };
  return (
    <Dialog open={open} onClose={() => askForPerson(false)} title="Who's working today?">
      <form onSubmit={done} className="grid gap-4">
        <p className="text-body text-muted">There&apos;s no login yet, so type your name. It is recorded with what you do.</p>
        <input aria-label="Your name" data-autofocus className={inputCls} value={draft} placeholder={me ?? "Your name"} onChange={(e) => setDraft(e.target.value)} />
        <div className="flex justify-end gap-2.5">
          <Button onClick={() => askForPerson(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!draft.trim()}>
            Use this name
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The four filters under Contracts; each links to the list with that filter on. */
const SUB_FILTERS = LIST_TABS.filter((t): t is { id: Exclude<ListTab, "all">; label: string } => t.id !== "all");

function ContractsGroup({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const filter = useSearchParams().get("filter");
  const me = useActingAs();
  const studies = useQuery({ queryKey: keys.studies, queryFn: api.studies });
  const counts = useMemo(() => (studies.data ? tabCounts(studies.data, me) : null), [studies.data, me]);
  const [open, setOpen] = useState(true);
  const onList = path === "/";
  return (
    <div>
      <div className={cx("flex items-center rounded-[10px]", onList && !filter && "bg-surface shadow-card")}>
        <Link href="/" aria-current={onList && !filter ? "page" : undefined} onClick={onNavigate} className={cx("group flex h-9 min-w-0 flex-1 items-center gap-2.5 px-2.5 text-body", onList && !filter ? "font-medium text-ink" : "text-ink-2 hover:text-ink")}>
          <FileText className={iconCls(onList && !filter)} strokeWidth={1.75} />
          <span className="truncate">Contracts</span>
        </Link>
        <button type="button" aria-label="Contract filters" aria-expanded={open} onClick={() => setOpen(!open)} className="mr-1 grid size-7 place-items-center rounded-lg text-muted hover:bg-ink/[0.06]">
          <ChevronDown aria-hidden className={cx("size-4 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>
      {open && (
        <ul className="mt-1 ml-[18px] flex flex-col gap-0.5 border-l border-line-strong/70 pl-2">
          {SUB_FILTERS.map((t) => {
            const active = onList && filter === t.id;
            return (
              <li key={t.id}>
                <Link href={`/?filter=${t.id}`} aria-current={active ? "page" : undefined} onClick={onNavigate} className={cx("flex h-8 items-center justify-between gap-2 rounded-[10px] px-2.5 text-small", active ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2 hover:bg-ink/[0.045] hover:text-ink")}>
                  <span className="truncate">{t.label}</span>
                  {counts && <span className="num text-faint">{counts[t.id]}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Search box and bell. The bell counts the contracts that need this person and opens that list. */
function SearchRow({ onSearch, onNavigate }: { onSearch: () => void; onNavigate?: () => void }) {
  const me = useActingAs();
  const studies = useQuery({ queryKey: keys.studies, queryFn: api.studies });
  const needs = studies.data ? tabCounts(studies.data, me)["needs-you"] : 0;
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onSearch} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 text-body text-faint shadow-button hover:border-ink/25">
        <Search aria-hidden className="size-[15px] shrink-0" strokeWidth={1.75} />
        <span className="flex-1 truncate text-left">Search</span>
        <kbd className="rounded-md bg-sunken px-1.5 text-caption font-medium text-muted">⌘K</kbd>
      </button>
      <Link href="/?filter=needs-you" onClick={onNavigate} aria-label={needs > 0 ? `${needs} ${needs === 1 ? "contract needs" : "contracts need"} you` : "Nothing needs you"} className="relative grid size-9 shrink-0 place-items-center rounded-[10px] text-muted hover:bg-ink/[0.06] hover:text-ink">
        <Bell aria-hidden className="size-[17px]" strokeWidth={1.75} />
        {needs > 0 && <span className="num absolute top-0.5 right-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-on-primary">{needs}</span>}
      </Link>
    </div>
  );
}

/** ⌘K: type a protocol, sponsor, site or doctor and open the contract. */
function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const studies = useQuery({ queryKey: keys.studies, queryFn: api.studies, enabled: open });
  const [q, setQ] = useState("");
  const found = (studies.data ?? []).filter((s) => matchesQuery(s, q)).slice(0, 8);
  const go = (id: string) => {
    onClose();
    router.push(`/studies/${id}`);
  };
  const close = () => {
    setQ("");
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Search contracts">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (found[0]) go(found[0].id);
        }}
        className="grid gap-3"
      >
        <input aria-label="Search contracts" data-autofocus className={inputCls} value={q} placeholder="Protocol, sponsor, site or doctor" onChange={(e) => setQ(e.target.value)} />
        {studies.isPending ? (
          <p className="text-body text-muted">Loading your contracts…</p>
        ) : studies.isError ? (
          <p className="text-body text-danger">We couldn&apos;t load your contracts. Close this and try again.</p>
        ) : found.length === 0 ? (
          <p className="text-body text-muted">{q.trim() ? "No contract matches that. Try a protocol number, a sponsor, a site or a doctor." : "You have no contracts yet."}</p>
        ) : (
          <ul className="flex flex-col">
            {found.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => go(s.id)} className="flex w-full flex-col rounded-[10px] px-3 py-2 text-left hover:bg-sunken">
                  <span className="truncate text-body font-medium">{studyTitle(s.protocol, s.firstDocument)}</span>
                  <span className="truncate text-small text-muted">{studySub(s.protocol, [s.sponsor, s.payer, s.site, s.pi])}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>
    </Dialog>
  );
}

function SidebarBody({ onNavigate, onClose, onSearch }: { onNavigate?: () => void; onClose?: () => void; onSearch: () => void }) {
  const path = usePathname();
  return (
    <div className="flex h-full flex-col gap-5 p-4">
      <div className="flex items-start justify-between gap-2">
        <Link href="/" onClick={onNavigate} className="flex flex-col gap-1.5 px-2 pt-2">
          <Image src="/dct-logo.png" alt="Discovery Clinical Trials" width={168} height={32} preload />
          <span className="pl-0.5 text-caption font-semibold tracking-[0.22em] text-accent uppercase">Finance</span>
        </Link>
        {onClose && (
          <Button variant="ghost" size="icon" aria-label="Close menu" onClick={onClose}>
            <X className="size-5" strokeWidth={1.75} />
          </Button>
        )}
      </div>

      <SearchRow onSearch={onSearch} onNavigate={onNavigate} />

      <nav aria-label="Main" className="flex flex-col gap-1">
        <ContractsGroup onNavigate={onNavigate} />
        <NavLink href="/activity" label="Activity" icon={History} active={path === "/activity"} onNavigate={onNavigate} />
        <NavLink href="/how-it-works" label="How it works" icon={HelpCircle} active={path === "/how-it-works"} onNavigate={onNavigate} />
      </nav>

      <div className="mt-auto flex flex-col gap-1 border-t border-line-strong/70 pt-2">
        <NavLink href="/settings" label="Settings" icon={Settings} active={path === "/settings"} onNavigate={onNavigate} />
        <PersonChip />
      </div>
    </div>
  );
}

/** Left column on desktop; a top bar with a slide-in menu on small screens. Owns the name picker. */
export function Sidebar() {
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const search = () => {
    setMenu(false);
    setSearching(true);
  };
  return (
    <>
      <aside className="hidden lg:sticky lg:top-0 lg:block lg:h-screen lg:overflow-y-auto">
        <SidebarBody onSearch={search} />
      </aside>

      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 bg-canvas/85 px-4 backdrop-blur-md lg:hidden">
        <Link href="/" className="mr-auto">
          <Image src="/dct-logo.png" alt="Discovery Clinical Trials" width={132} height={25} />
        </Link>
        <Button variant="ghost" size="icon" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(true)}>
          <Menu className="size-5" strokeWidth={1.75} />
        </Button>
      </header>
      <Sheet open={menu} onClose={() => setMenu(false)} label="Menu" width="w-[288px] max-w-[85vw]">
        <SidebarBody onNavigate={() => setMenu(false)} onClose={() => setMenu(false)} onSearch={search} />
      </Sheet>

      <SearchDialog open={searching} onClose={() => setSearching(false)} />
      <PersonPicker />
    </>
  );
}
