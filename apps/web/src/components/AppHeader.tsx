"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { MOCK } from "@/lib/api";
import { setActingAs, useActingAs } from "@/lib/acting-as";
import { useSettings } from "@/lib/queries";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "Studies", match: (p: string) => p === "/" || p.startsWith("/studies") },
  { href: "/audit", label: "Audit log", match: (p: string) => p.startsWith("/audit") },
  { href: "/settings", label: "Settings", match: (p: string) => p.startsWith("/settings") },
];

export function AppHeader() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent text-sm text-on-accent">
            ¢
          </span>
          DCT Finance
          {MOCK && (
            <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn" title="Running against in-browser mock data">
              Demo data
            </span>
          )}
        </Link>
        <nav aria-label="Main" className="flex gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={n.match(path) ? "page" : undefined}
              className={cx("rounded-md px-3 py-1.5 text-sm", n.match(path) ? "bg-sunken font-medium text-ink" : "text-muted hover:text-ink")}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto">
          <ActingAsPicker />
        </div>
      </div>
    </header>
  );
}

function ActingAsPicker() {
  const me = useActingAs();
  const { data } = useSettings();
  const people = data?.people ?? [];
  // Forget a name that was removed from the people list.
  useEffect(() => {
    if (data && me && !people.includes(me)) setActingAs(null);
  }, [data, me, people]);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">Acting as</span>
      <select
        value={me ?? ""}
        onChange={(e) => setActingAs(e.target.value || null)}
        className={cx("h-8 rounded-md border bg-surface px-2 text-sm", me ? "border-line-strong" : "border-warn text-warn")}
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
  return <p className="text-xs text-warn">Choose who you are acting as (top right) to make changes.</p>;
}
