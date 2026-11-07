"use client";

import { Search } from "lucide-react";
import { useId, useState } from "react";
import type { PartyRow } from "@/lib/types";
import { cx, inputBase } from "../ui";

/** A party matches on its name or any other name it is known by, ignoring case. */
export const matchesParty = (p: Pick<PartyRow, "name" | "aliases">, query: string) => {
  const q = query.trim().toLowerCase();
  return !q || [p.name, ...p.aliases].some((n) => n.toLowerCase().includes(q));
};

export const contractsText = (n: number) => `${n} contract${n === 1 ? "" : "s"}`;

/**
 * A searchable list of parties to choose one from (radio buttons, so the keyboard and screen readers work as they
 * should). `none`: adds an always-visible first choice that means "no party", with value null.
 */
export function PartyPicker({ parties, value, onChange, label, none }: { parties: PartyRow[]; value: string | null; onChange: (id: string | null) => void; label: string; none?: string }) {
  const [query, setQuery] = useState("");
  const name = useId();
  const shown = parties.filter((p) => matchesParty(p, query));
  const row = "flex cursor-pointer items-start gap-3 rounded-field px-3 py-2 hover:bg-sunken has-[:checked]:bg-brand-soft";
  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">Search {label}</span>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
        <input type="search" data-autofocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" className={cx(inputBase, "w-full pl-10")} />
      </label>
      <fieldset className="max-h-64 overflow-y-auto rounded-field ring-1 ring-line">
        <legend className="sr-only">{label}</legend>
        {none && (
          <label className={row}>
            <input type="radio" name={name} checked={value === null} onChange={() => onChange(null)} className="mt-1 accent-primary" />
            <span className="text-body text-muted">{none}</span>
          </label>
        )}
        {shown.map((p) => (
          <label key={p.id} className={row}>
            <input type="radio" name={name} checked={value === p.id} onChange={() => onChange(p.id)} className="mt-1 accent-primary" />
            <span className="min-w-0 flex-1">
              <span title={p.name} className="block truncate text-body font-medium">
                {p.name}
              </span>
              {p.aliases.length > 0 && (
                <span title={p.aliases.join(", ")} className="block truncate text-small text-faint">
                  Also known as {p.aliases.join(", ")}
                </span>
              )}
            </span>
            <span className="text-small whitespace-nowrap text-faint">{contractsText(p.studies)}</span>
          </label>
        ))}
        {shown.length === 0 && <p className="px-3 py-4 text-body text-muted">{query.trim() ? `Nothing matches “${query.trim()}”.` : `No ${label} yet.`}</p>}
      </fieldset>
    </div>
  );
}
