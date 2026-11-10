"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Party, PartyKind, Study } from "@/lib/types";
import { Button, Dialog, ErrorNote } from "../ui";
import { PartyPicker } from "./PartyPicker";

type Slot = "sponsorId" | "payerId" | "siteId";
const SLOTS: { slot: Slot; field: "sponsor" | "payer" | "site"; kind: PartyKind; label: string; plural: string }[] = [
  { slot: "sponsorId", field: "sponsor", kind: "sponsor", label: "Sponsor", plural: "sponsors" },
  { slot: "payerId", field: "payer", kind: "cro", label: "CRO", plural: "CROs" },
  { slot: "siteId", field: "site", kind: "site", label: "Site", plural: "sites" },
];
type SlotInfo = (typeof SLOTS)[number];

function ChangeForm({ study, info, current, me, done }: { study: Study; info: SlotInfo; current: Party | null; me: string; done: () => void }) {
  const client = useQueryClient();
  const parties = useQuery({ queryKey: keys.parties, queryFn: api.parties });
  const [chosen, setChosen] = useState<string | null>(current?.id ?? null);
  const save = useMutation({
    mutationFn: () => api.setStudyParties(study.id, { [info.slot]: chosen }, me),
    onSuccess: (updated) => {
      client.setQueryData(keys.study(study.id), updated);
      void client.invalidateQueries({ queryKey: keys.studies });
      done();
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-muted">
        This only changes this contract. To fix a name everywhere, rename it in{" "}
        <Link href="/settings" className="font-medium text-accent hover:underline">
          Settings
        </Link>
        .
      </p>
      {parties.isError ? (
        <ErrorNote error={parties.error} retry={() => void parties.refetch()} />
      ) : parties.isPending ? (
        <p role="status" className="text-body text-muted">Loading names…</p>
      ) : (
        <PartyPicker parties={parties.data.filter((p) => p.kind === info.kind)} value={chosen} onChange={setChosen} label={info.plural} none="Not set" />
      )}
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2.5">
        <Button onClick={done}>Cancel</Button>
        <Button variant="primary" disabled={chosen === (current?.id ?? null) || !parties.data || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/** Sponsor, CRO and site of a contract, each with a way to point it at another existing party. Renders from props, so it can't mismatch the server's HTML. */
export function ContractParties({ study }: { study: Study }) {
  const me = useActingAs();
  const [editing, setEditing] = useState<SlotInfo | null>(null);
  return (
    <>
      <ul aria-label="Parties on this contract" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {SLOTS.map((s) => {
          const p = study[s.field];
          return (
            <li key={s.slot} className="flex max-w-full min-w-0 items-center gap-2 rounded-field bg-sunken py-1 pr-1.5 pl-3 sm:max-w-[340px]">
              <span className="text-small whitespace-nowrap text-faint">{s.label}</span>
              <span title={p?.name} className={p ? "min-w-0 flex-1 truncate text-small font-medium text-ink" : "min-w-0 flex-1 truncate text-small text-muted"}>
                {p?.name ?? "Not set"}
              </span>
              <Button variant="ghost" size="sm" className="h-7 px-2.5" aria-label={`Change ${s.label}`} onClick={() => (me ? setEditing(s) : askForPerson())}>
                Change
              </Button>
            </li>
          );
        })}
      </ul>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing ? `Change the ${editing.label}` : "Change"}>
        {editing && me && <ChangeForm study={study} info={editing} current={study[editing.field]} me={me} done={() => setEditing(null)} />}
      </Dialog>
    </>
  );
}
