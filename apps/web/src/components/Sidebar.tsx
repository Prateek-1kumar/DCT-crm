"use client";

import { FileText, Menu, X, type LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type FormEvent } from "react";
import { askForPerson, setActingAs, useActingAs, usePersonPrompt } from "@/lib/acting-as";
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

function SidebarBody({ onNavigate, onClose }: { onNavigate?: () => void; onClose?: () => void }) {
  const path = usePathname();
  return (
    <div className="flex h-full flex-col gap-6 p-4">
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

      <nav aria-label="Main" className="flex flex-col gap-1">
        <NavLink href="/" label="Contracts" icon={FileText} active={path === "/"} onNavigate={onNavigate} />
      </nav>

      <div className="mt-auto border-t border-line-strong/70 pt-2">
        <PersonChip />
      </div>
    </div>
  );
}

/** Left column on desktop; a top bar with a slide-in menu on small screens. Owns the name picker. */
export function Sidebar() {
  const [menu, setMenu] = useState(false);
  return (
    <>
      <aside className="hidden lg:sticky lg:top-0 lg:block lg:h-screen lg:overflow-y-auto">
        <SidebarBody />
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
        <SidebarBody onNavigate={() => setMenu(false)} onClose={() => setMenu(false)} />
      </Sheet>

      <PersonPicker />
    </>
  );
}
