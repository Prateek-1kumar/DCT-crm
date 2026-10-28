"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { MOCK } from "@/lib/api";
import { setActingAs, useActingAs } from "@/lib/acting-as";
import { useSettings, useStudies } from "@/lib/queries";
import { summaryStage } from "@/lib/review";
import { cx } from "./ui";

const Icon = ({ children }: { children: ReactNode }) => (
  <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="size-[17px] flex-none">
    {children}
  </svg>
);

const NAV = [
  {
    href: "/",
    label: "Contracts",
    match: (p: string) => p === "/" || p.startsWith("/studies"),
    icon: (
      <Icon>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5M9 13h6M9 17h6" />
      </Icon>
    ),
  },
  {
    href: "/audit",
    label: "Activity",
    match: (p: string) => p.startsWith("/audit"),
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </Icon>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    match: (p: string) => p.startsWith("/settings"),
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </Icon>
    ),
  },
];

/** Left column: logo, the three places that work, sample-data note. */
export function Sidebar() {
  const path = usePathname();
  const { data } = useStudies();
  // Contracts waiting on someone: questions, approval, or a failed read.
  const waiting = (data ?? []).filter((s) => ["Needs you", "Approve"].includes(summaryStage(s).stage) || s.status === "extraction_failed").length;
  return (
    <aside className="flex flex-col gap-1 border-b border-line bg-surface px-3.5 py-4 lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0">
      <Link href="/" className="mb-2.5 flex flex-col gap-1.5 border-b border-line px-2 pt-1 pb-4">
        <Image src="/dct-logo.png" alt="Discovery Clinical Trials" width={176} height={33} priority className="dark:rounded dark:bg-white dark:p-1" />
        <span className="text-[11px] tracking-[0.2em] text-accent uppercase">Finance</span>
      </Link>
      <nav aria-label="Main" className="flex gap-1 lg:flex-col">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={n.match(path) ? "page" : undefined}
            className={cx("flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2", n.match(path) ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-sunken")}
          >
            {n.icon}
            {n.label}
            {n.href === "/" && waiting > 0 && (
              <span className="ml-auto min-w-5 rounded-full bg-ink px-1.5 text-center text-[11px] text-surface" title={`${waiting} waiting on someone`}>
                {waiting}
              </span>
            )}
          </Link>
        ))}
      </nav>
      {MOCK && (
        <p className="mt-auto hidden border-t border-line px-2 pt-3 text-[11px] text-muted lg:block">
          Runs on sample data. Reset it in <Link href="/settings" className="text-accent">Settings</Link>.
        </p>
      )}
    </aside>
  );
}

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-end gap-3 border-b border-line bg-canvas/85 px-5 backdrop-blur-md lg:px-7">
      <ActingAsPicker />
    </header>
  );
}

function ActingAsPicker() {
  const me = useActingAs();
  const { data } = useSettings();
  const people = data?.people ?? [];
  // Forget a name that was removed from the people list.
  useEffect(() => {
    if (data && me && !data.people.includes(me)) setActingAs(null);
  }, [data, me]);
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <span className="text-muted">Acting as</span>
      <select
        value={me ?? ""}
        onChange={(e) => setActingAs(e.target.value || null)}
        className={cx("h-9 rounded-[10px] border bg-surface px-3 text-[13px]", me ? "border-line-strong" : "border-warn text-warn")}
      >
        <option value="">Choose your name…</option>
        {people.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </label>
  );
}

/** Inline prompt shown next to actions when nobody is selected. */
export function NeedsPerson() {
  return <p className="text-xs text-warn">Choose your name under “Acting as” (top right) first.</p>;
}
