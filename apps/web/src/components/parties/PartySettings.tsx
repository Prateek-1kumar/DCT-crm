"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { PartyKind, PartyRow } from "@/lib/types";
import { useMounted } from "@/lib/use-mounted";
import { Skeleton } from "../study/Skeleton";
import { Button, Card, Dialog, Empty, ErrorNote, Field, inputBase, inputCls, LoadError, PageTitle, pageCls, cx } from "../ui";
import { contractsText, matchesParty, PartyPicker } from "./PartyPicker";

const GROUPS: { kind: PartyKind; label: string; one: string; none: string }[] = [
  { kind: "sponsor", label: "Sponsors", one: "sponsor", none: "No sponsors yet. They appear here once a contract has been read." },
  { kind: "cro", label: "CROs", one: "CRO", none: "No CROs yet. They appear here once a contract has been read." },
  { kind: "site", label: "Sites", one: "site", none: "No sites yet. They appear here once a contract has been read." },
];

const SHOWN_ALIASES = 3;

function Aliases({ aliases }: { aliases: string[] }) {
  const [all, setAll] = useState(false);
  if (aliases.length === 0) return null;
  const hidden = aliases.length - SHOWN_ALIASES;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="text-small text-faint">Also known as</span>
      {(all ? aliases : aliases.slice(0, SHOWN_ALIASES)).map((a) => (
        <span key={a} title={a} className="max-w-[220px] truncate rounded-full bg-ink/[0.06] px-2.5 py-0.5 text-small text-ink-2">
          {a}
        </span>
      ))}
      {hidden > 0 && (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} title={all ? undefined : aliases.slice(SHOWN_ALIASES).join(", ")} className="rounded-full px-2 py-0.5 text-small font-medium text-accent hover:bg-brand-soft">
          {all ? "Show fewer" : <>+{hidden}<span className="sr-only"> more names</span></>}
        </button>
      )}
    </div>
  );
}

function RenameForm({ party, me, done, cancel }: { party: PartyRow; me: string; done: (msg: string) => void; cancel: () => void }) {
  const [name, setName] = useState(party.name);
  const trimmed = name.trim();
  const rename = useMutation({ mutationFn: () => api.renameParty(party.id, trimmed, me), onSuccess: () => done(`Renamed “${party.name}” to “${trimmed}”.`) });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed && trimmed !== party.name) rename.mutate();
      }}
    >
      <p className="text-body text-muted">
        {party.studies > 0 ? `This changes the name on ${contractsText(party.studies)}.` : "No contract uses this name yet."} “{party.name}” is kept as another name for it, so future readings of a contract that uses the old wording still match.
      </p>
      <Field label="New name" htmlFor="party-name">
        <input id="party-name" data-autofocus value={name} onChange={(e) => setName(e.target.value)} className={inputCls} autoComplete="off" />
      </Field>
      <ErrorNote error={rename.error} />
      <div className="flex justify-end gap-2.5">
        <Button onClick={cancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!trimmed || trimmed === party.name || rename.isPending}>
          {rename.isPending ? "Renaming…" : "Rename"}
        </Button>
      </div>
    </form>
  );
}

function MergeForm({ party, others, me, done, cancel }: { party: PartyRow; others: PartyRow[]; me: string; done: (msg: string) => void; cancel: () => void }) {
  const [into, setInto] = useState<string | null>(null);
  const target = others.find((p) => p.id === into);
  const merge = useMutation({ mutationFn: () => api.mergeParty(party.id, into!, me), onSuccess: () => done(`Merged “${party.name}” into “${target!.name}”.`) });
  const kind = GROUPS.find((g) => g.kind === party.kind)!.one;
  if (others.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-body text-muted">There is no other {kind} to merge “{party.name}” into.</p>
        <div className="flex justify-end">
          <Button onClick={cancel}>Got it</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-muted">Pick the {kind} that should stay. “{party.name}” can only be merged into another {kind}.</p>
      <PartyPicker parties={others} value={into} onChange={setInto} label={`${kind}s`} />
      {target && (
        <p className="rounded-field bg-warn-soft px-4 py-3 text-body text-warn">
          Its {contractsText(party.studies)} {party.studies === 1 ? "moves" : "move"} to {target.name}. Its names become other names for {target.name}. This can&apos;t be undone.
        </p>
      )}
      <ErrorNote error={merge.error} />
      <div className="flex justify-end gap-2.5">
        <Button onClick={cancel}>Cancel</Button>
        <Button variant="danger" disabled={!target || merge.isPending} onClick={() => merge.mutate()}>
          {merge.isPending ? "Merging…" : target ? `Merge into ${target.name}` : "Merge"}
        </Button>
      </div>
    </div>
  );
}

function PartyItem({ party, onRename, onMerge }: { party: PartyRow; onRename: () => void; onMerge: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-3.5 first:border-t-0">
      <div className="min-w-0 flex-1 basis-[260px]">
        <p title={party.name} className="truncate text-body font-semibold">
          {party.name}
        </p>
        <Aliases aliases={party.aliases} />
      </div>
      <span className="text-small whitespace-nowrap text-muted">{contractsText(party.studies)}</span>
      <div className="flex gap-2">
        <Button size="sm" onClick={onRename} aria-label={`Rename ${party.name}`}>
          Rename
        </Button>
        <Button size="sm" onClick={onMerge} aria-label={`Merge into… (${party.name})`}>
          Merge into…
        </Button>
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div aria-label="Loading names" className="flex flex-col gap-6">
      {[0, 1].map((i) => (
        <Card key={i} className="p-5">
          <Skeleton className="h-4 w-28" />
          {[0, 1, 2].map((j) => (
            <Skeleton key={j} className="mt-5 h-4 w-64 max-w-full" />
          ))}
        </Card>
      ))}
    </div>
  );
}

export function PartySettings() {
  const parties = useQuery({ queryKey: keys.parties, queryFn: api.parties });
  const client = useQueryClient();
  const me = useActingAs();
  const mounted = useMounted();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<{ action: "rename" | "merge"; party: PartyRow } | null>(null);
  const [notice, setNotice] = useState("");

  // the sidebar or another screen may have filled the cache before this hydrates: drawing it then would not match the server's HTML
  const all = mounted ? parties.data : undefined;
  const pending = parties.isPending || !mounted;

  const start = (action: "rename" | "merge", party: PartyRow) => {
    if (!me) return askForPerson();
    setNotice("");
    setOpen({ action, party });
  };
  const done = (msg: string) => {
    setOpen(null);
    setNotice(msg);
    // Every screen that shows a party's name: the list, the contract headers and the lists of parties itself. ["study"] is the prefix of every contract's key.
    void client.invalidateQueries({ queryKey: keys.parties });
    void client.invalidateQueries({ queryKey: keys.studies });
    void client.invalidateQueries({ queryKey: ["study"] });
  };

  const matching = (all ?? []).filter((p) => matchesParty(p, search));

  return (
    <div className={pageCls}>
      <PageTitle title="Settings" />
      <section aria-labelledby="parties-heading" className="max-w-[860px]">
        <h2 id="parties-heading" className="text-title font-semibold tracking-tight">
          Sponsors, CROs and sites
        </h2>
        <p className="mt-1 mb-5 text-body text-muted">The reader takes these names from each contract. Keeping one record per company means a rule saved for it applies to every contract.</p>

        <div role="status" aria-live="polite" className={notice ? "mb-5 rounded-field bg-ok-soft px-4 py-3 text-body text-ok" : "sr-only"}>
          {notice}
        </div>

        {parties.isError && mounted ? (
          <LoadError error={parties.error} retry={() => void parties.refetch()} what="the list of names" back={{ href: "/", label: "Back to contracts" }} />
        ) : pending ? (
          <ListSkeleton />
        ) : all!.length === 0 ? (
          <Empty title="No names yet">Sponsors, CROs and sites show up here once a contract has been read.</Empty>
        ) : (
          <>
            <label className="relative mb-6 block w-full sm:w-[360px]">
              <span className="sr-only">Search names</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or other name" className={cx(inputBase, "w-full pl-10")} />
            </label>
            {search.trim() && matching.length === 0 && <p className="rounded-card bg-surface px-5 py-10 text-center text-body text-muted shadow-card">No name matches “{search.trim()}”.</p>}
            <div className="flex flex-col gap-6">
              {GROUPS.map((g) => {
                const rows = matching.filter((p) => p.kind === g.kind);
                if (search.trim() && rows.length === 0) return null;
                return (
                  <Card key={g.kind} className="overflow-hidden">
                    <h3 className="flex items-center gap-2 px-5 pt-5 pb-3 text-body font-semibold">
                      {g.label} <span className="num text-faint">{rows.length}</span>
                    </h3>
                    {rows.length === 0 ? (
                      <p className="border-t border-line px-5 py-6 text-body text-muted">{g.none}</p>
                    ) : (
                      <ul className="border-t border-line">
                        {rows.map((p) => (
                          <PartyItem key={p.id} party={p} onRename={() => start("rename", p)} onMerge={() => start("merge", p)} />
                        ))}
                      </ul>
                    )}
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </section>

      <Dialog open={open?.action === "rename"} onClose={() => setOpen(null)} title="Rename">
        {open?.action === "rename" && me && <RenameForm party={open.party} me={me} done={done} cancel={() => setOpen(null)} />}
      </Dialog>
      <Dialog open={open?.action === "merge"} onClose={() => setOpen(null)} title={open ? `Merge ${open.party.name}` : "Merge"}>
        {open?.action === "merge" && me && <MergeForm party={open.party} others={(all ?? []).filter((p) => p.kind === open.party.kind && p.id !== open.party.id)} me={me} done={done} cancel={() => setOpen(null)} />}
      </Dialog>
    </div>
  );
}
