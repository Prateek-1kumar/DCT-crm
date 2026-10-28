"use client";

import { BookOpen, ChevronRight, FileText, History, Menu, Search, Settings, X, type LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { askForPerson, askForPersonOnce, setActingAs, useActingAs, usePersonPrompt } from "@/lib/acting-as";
import { MOCK } from "@/lib/api";
import { useSettings, useStudyCounts } from "@/lib/queries";
import { VIEWS, type ViewId } from "@/lib/review";
import { AlertBell, AlertWatcher } from "./Alerts";
import { CommandPalette } from "./CommandPalette";
import { HowItWorks } from "./HowItWorks";
import { Button, cx, Dialog } from "./ui";

const VIEW_BADGE: Record<ViewId, string> = {
  "needs-you": "bg-warn-soft text-warn",
  approval: "bg-brand-soft text-accent",
  live: "bg-ink/[0.06] text-ink-2",
  failed: "bg-danger-soft text-danger",
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function Count({ n, cls }: { n: number; cls: string }) {
  if (!n) return null;
  return <span className={cx("num grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-caption font-semibold", cls)}>{n}</span>;
}

const itemCls = (active: boolean) =>
  cx(
    "group flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-body transition-[background-color,box-shadow,color] duration-150",
    active ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2 hover:bg-ink/[0.045] hover:text-ink",
  );

const iconCls = (active: boolean) => cx("size-[17px] shrink-0 transition-colors", active ? "text-brand" : "text-muted group-hover:text-ink-2");

function NavLink({ href, label, icon: Icon, active, badge, onNavigate }: { href: string; label: string; icon: LucideIcon; active: boolean; badge?: ReactNode; onNavigate?: () => void }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={itemCls(active)} onClick={onNavigate}>
      <Icon className={iconCls(active)} strokeWidth={1.75} />
      <span className="truncate">{label}</span>
      {badge && <span className="ml-auto">{badge}</span>}
    </Link>
  );
}

function NavButton({ label, icon: Icon, onClick, hint }: { label: string; icon: LucideIcon; onClick: () => void; hint?: string }) {
  return (
    <button type="button" className={itemCls(false)} onClick={onClick}>
      <Icon className={iconCls(false)} strokeWidth={1.75} />
      <span className="truncate">{label}</span>
      {hint && <kbd className="ml-auto rounded-md bg-ink/[0.06] px-1.5 py-0.5 font-sans text-caption text-muted">{hint}</kbd>}
    </button>
  );
}

/** Contracts, with the four shortcuts into the list underneath (open unless folded). */
function ContractsNav({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const view = useSearchParams().get("view");
  const { data } = useStudyCounts();
  const [open, setOpen] = useState(true);
  const count = (id: ViewId) => data?.views[id] ?? 0;
  const waiting = count("needs-you") + count("approval") + count("failed");
  const onContracts = path === "/" || path.startsWith("/studies");

  return (
    <div className="flex flex-col">
      <div className={cx(itemCls(onContracts && !view), "pr-1.5")}>
        <Link href="/" aria-current={onContracts && !view ? "page" : undefined} onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-3 self-stretch">
          <FileText className={iconCls(onContracts && !view)} strokeWidth={1.75} />
          <span className="truncate">Contracts</span>
        </Link>
        {/* The total only while the shortcuts (which carry their own counts) are folded. */}
        {!open && <Count n={waiting} cls="bg-warn-soft text-warn" />}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide contract shortcuts" : "Show contract shortcuts"}
          onClick={() => setOpen(!open)}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-ink/[0.06] hover:text-ink"
        >
          <ChevronRight className={cx("size-4 transition-transform duration-200", open && "rotate-90")} strokeWidth={2} />
        </button>
      </div>
      <div className={cx("grid transition-[grid-template-rows,opacity] duration-300 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="relative min-h-0 overflow-hidden">
          <span aria-hidden className="absolute top-1 bottom-1 left-[18px] w-px bg-line-strong" />
          <ul className="flex flex-col gap-0.5 py-1 pl-8">
            {VIEWS.map((v) => {
              const active = path === "/" && view === v.id;
              return (
                <li key={v.id}>
                  <Link
                    href={`/?view=${v.id}`}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cx(
                      "flex h-8 items-center gap-2 rounded-[9px] px-2.5 text-small transition-colors",
                      active ? "bg-surface font-medium text-ink shadow-card" : "text-muted hover:bg-ink/[0.045] hover:text-ink",
                    )}
                  >
                    <span className="truncate">{v.label}</span>
                    <span className="ml-auto">
                      <Count n={count(v.id)} cls={VIEW_BADGE[v.id]} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Bottom of the sidebar: who is working. No login yet, so people pick their name. */
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
        <span className="block text-caption text-faint">{me ? "Working now · switch" : "So your answers are signed"}</span>
      </span>
    </button>
  );
}

/** "Who's working today?" Opens from the chip, or once when an action first needs a name. */
function PersonPicker() {
  const open = usePersonPrompt();
  const me = useActingAs();
  const { data } = useSettings();
  const people = data?.people ?? [];
  // Forget a name that was removed from the people list.
  useEffect(() => {
    if (data && me && !data.people.includes(me)) setActingAs(null);
  }, [data, me]);
  return (
    <Dialog open={open} onClose={() => askForPerson(false)} title="Who's working today?">
      <p className="text-body text-muted">There&apos;s no login yet, so pick your name. Every answer, correction and approval is signed with it.</p>
      <ul className="mt-5 grid gap-2">
        {people.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => {
                setActingAs(p);
                askForPerson(false);
              }}
              className={cx(
                "flex w-full items-center gap-3 rounded-tile border p-3 text-left transition-colors",
                p === me ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong hover:bg-sunken",
              )}
            >
              <span aria-hidden className="grid size-10 place-items-center rounded-full bg-brand-soft text-small font-semibold text-accent">
                {initials(p)}
              </span>
              <span className="text-body font-medium">{p}</span>
              {p === me && <span className="ml-auto text-small text-accent">You</span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-small text-faint">
        Not on the list? Add people in{" "}
        <Link href="/settings" className="text-accent hover:underline" onClick={() => askForPerson(false)}>
          Settings
        </Link>
        .
      </p>
    </Dialog>
  );
}

/** Inline note next to actions that need a name; opens the picker the first time it appears. */
export function NeedsPerson() {
  useEffect(() => askForPersonOnce(), []);
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-small text-warn">
      Pick your name first, so this is signed by you.
      <button type="button" onClick={() => askForPerson()} className="font-medium underline underline-offset-2">
        Choose name
      </button>
    </p>
  );
}

function SidebarBody({ onSearch, onGuide, onNavigate, onClose }: { onSearch: () => void; onGuide: () => void; onNavigate?: () => void; onClose?: () => void }) {
  const path = usePathname();
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-start justify-between gap-2">
        <Link href="/" onClick={onNavigate} className="flex flex-col gap-1.5 px-2 pt-2">
          <Image src="/dct-logo.png" alt="Discovery Clinical Trials" width={168} height={32} priority />
          <span className="pl-0.5 text-caption font-semibold tracking-[0.22em] text-accent uppercase">Finance</span>
        </Link>
        {onClose && (
          <Button variant="ghost" size="icon" aria-label="Close menu" onClick={onClose}>
            <X className="size-5" strokeWidth={1.75} />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onSearch}
          className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] bg-surface/70 px-2.5 text-left text-body text-faint shadow-button ring-1 ring-ink/[0.06] transition hover:bg-surface hover:text-muted"
        >
          <Search className="size-[17px]" strokeWidth={1.75} />
          Search
          <kbd className="ml-auto rounded-md bg-ink/[0.06] px-1.5 py-0.5 font-sans text-caption text-muted">⌘K</kbd>
        </button>
        <AlertBell />
      </div>

      <nav aria-label="Main" className="flex flex-col gap-1">
        <ContractsNav onNavigate={onNavigate} />
        <NavLink href="/audit" label="Activity" icon={History} active={path.startsWith("/audit")} onNavigate={onNavigate} />
      </nav>

      <div className="mt-auto flex flex-col gap-1">
        <NavButton label="How it works" icon={BookOpen} onClick={onGuide} />
        <NavLink href="/settings" label="Settings" icon={Settings} active={path.startsWith("/settings")} onNavigate={onNavigate} />
        {MOCK && (
          <p className="px-3 pt-2 text-caption text-faint">
            Sample data only.{" "}
            <Link href="/settings" onClick={onNavigate} className="text-accent hover:underline">
              Reset it
            </Link>
          </p>
        )}
        <div className="mt-2 border-t border-line-strong/70 pt-2">
          <PersonChip />
        </div>
      </div>
    </div>
  );
}

/**
 * Left column on desktop; a top bar with a slide-in menu on small screens. Owns ⌘K search, the guide and the name picker.
 * `bare` (focus mode): only those three, no navigation, so the page gets the whole window.
 */
export function Sidebar({ bare }: { bare?: boolean }) {
  const me = useActingAs();
  const [search, setSearch] = useState(false);
  const [guide, setGuide] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const body = (drawer?: () => void) => <SidebarBody onSearch={() => setSearch(true)} onGuide={() => setGuide(true)} onNavigate={drawer} onClose={drawer} />;
  const dialogs = (
    <>
      <CommandPalette open={search} onClose={() => setSearch(false)} onGuide={() => setGuide(true)} />
      <HowItWorks open={guide} onClose={() => setGuide(false)} />
      <PersonPicker />
      <AlertWatcher key={me ?? ""} />
    </>
  );
  if (bare) return dialogs;

  return (
    <>
      <aside className="hidden lg:sticky lg:top-0 lg:block lg:h-screen lg:overflow-y-auto">{body()}</aside>

      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 bg-canvas/85 px-4 backdrop-blur-md lg:hidden">
        <Link href="/" className="mr-auto">
          <Image src="/dct-logo.png" alt="Discovery Clinical Trials" width={132} height={25} />
        </Link>
        <AlertBell />
        <Button variant="ghost" size="icon" aria-label="Search" onClick={() => setSearch(true)}>
          <Search className="size-5" strokeWidth={1.75} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(true)}>
          <Menu className="size-5" strokeWidth={1.75} />
        </Button>
      </header>
      {menu && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-backdrop" onClick={() => setMenu(false)} />
          <div className="absolute inset-y-0 left-0 w-[288px] max-w-[85vw] overflow-y-auto bg-canvas shadow-raised">
            {body(() => setMenu(false))}
          </div>
        </div>
      )}

      {dialogs}
    </>
  );
}
