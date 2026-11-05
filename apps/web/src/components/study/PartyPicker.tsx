"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Party, PartyKind } from "@/lib/types";
import { ErrorNote, Field, inputCls, cx } from "../ui";

const KIND_WORD: Record<PartyKind, string> = { sponsor: "sponsor", cro: "CRO or payer", site: "site" };

export function PartyPicker({ kind, label, hint, value, onChange }: { kind: PartyKind; label: string; hint?: string; value: Party | null; onChange: (party: Party | null) => void }) {
  const id = useId();
  const by = useActingAs();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 200);
    return () => clearTimeout(t);
  }, [text]);

  const found = useQuery({ queryKey: keys.parties(kind, search), queryFn: () => api.parties(kind, search), enabled: open && !value });
  const create = useMutation({
    mutationFn: (name: string) => api.createParty({ kind, name, by: by! }),
    onSuccess: (party) => {
      void queryClient.invalidateQueries({ queryKey: ["parties"] });
      pick(party);
    },
  });

  const typed = text.trim();
  const parties = found.data ?? [];
  const canAdd = typed !== "" && found.isSuccess && search === typed && !parties.some((p) => p.name.toLowerCase() === typed.toLowerCase());
  const rows = [...parties.map((p) => ({ key: p.id, label: p.name, party: p })), ...(canAdd ? [{ key: "new", label: `Add '${typed}' as a new ${KIND_WORD[kind]}`, party: null }] : [])];

  function pick(party: Party) {
    onChange(party);
    setText(party.name);
    setOpen(false);
    setActive(-1);
  }

  function choose(i: number) {
    const row = rows[i];
    if (!row) return;
    if (row.party) return pick(row.party);
    if (!by) return askForPerson();
    create.mutate(typed);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (rows.length ? (a + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : -1));
    } else if (e.key === "Enter" && open && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="relative" onBlur={(e) => e.currentTarget.contains(e.relatedTarget) || setOpen(false)}>
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
          autoComplete="off"
          className={inputCls}
          value={text}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(-1);
            if (value) onChange(null);
          }}
        />
        {open && !value && (
          <ul id={`${id}-list`} role="listbox" aria-label={label} className="absolute z-10 mt-1.5 max-h-64 w-full overflow-auto rounded-field border border-line-strong bg-surface p-1.5 shadow-raised">
            {found.isPending && <li className="px-3 py-2 text-small text-muted">Searching…</li>}
            {found.isError && <li className="px-3 py-2 text-small text-danger">The list didn&apos;t load. Keep typing to try again.</li>}
            {found.isSuccess && rows.length === 0 && <li className="px-3 py-2 text-small text-muted">Nothing yet. Type a name to add it.</li>}
            {rows.map((row, i) => (
              <li
                key={row.key}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={cx("cursor-pointer rounded-[10px] px-3 py-2 text-body", i === active ? "bg-brand-soft text-accent" : "hover:bg-sunken", !row.party && "font-medium text-accent")}
              >
                {row.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {create.isError && <ErrorNote error={create.error} />}
    </Field>
  );
}
