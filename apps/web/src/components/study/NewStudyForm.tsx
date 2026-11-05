"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Party } from "@/lib/types";
import { Button, Card, ErrorNote, Field, inputCls, PageTitle, pageCls } from "../ui";
import { PartyPicker } from "./PartyPicker";

export function NewStudyForm() {
  const router = useRouter();
  const by = useActingAs();
  const queryClient = useQueryClient();
  const [protocol, setProtocol] = useState("");
  const [sponsor, setSponsor] = useState<Party | null>(null);
  const [payer, setPayer] = useState<Party | null>(null);
  const [site, setSite] = useState<Party | null>(null);

  const create = useMutation({
    mutationFn: () => api.createStudy({ protocol: protocol.trim(), sponsorId: sponsor!.id, payerId: payer?.id ?? null, siteId: site!.id, by: by! }),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: keys.studies });
      router.push(`/studies/${id}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!by) return askForPerson();
    create.mutate();
  }

  return (
    <div className={pageCls}>
      <PageTitle title="New contract" sub="Tell us which study this is. You'll add the contract PDFs on the next screen." />
      <Card className="max-w-[640px] p-8">
        <form onSubmit={submit} className="flex flex-col gap-6">
          <Field label="Protocol number" htmlFor="protocol">
            <input id="protocol" className={inputCls} value={protocol} onChange={(e) => setProtocol(e.target.value)} autoComplete="off" />
          </Field>
          <PartyPicker kind="sponsor" label="Sponsor" value={sponsor} onChange={setSponsor} />
          <PartyPicker kind="cro" label="CRO or payer (optional)" hint="Leave this empty when the sponsor pays directly." value={payer} onChange={setPayer} />
          <PartyPicker kind="site" label="Site" value={site} onChange={setSite} />
          <ErrorNote error={create.error} />
          <div>
            <Button type="submit" variant="primary" disabled={!protocol.trim() || !sponsor || !site || create.isPending}>
              {create.isPending ? "Creating…" : "Create contract"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
