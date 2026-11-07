"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, btnCls, Card, ErrorNote, LoadError, pageCls } from "@/components/ui";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { ApiError } from "@/lib/api";
import { api, keys } from "@/lib/queries";
import type { Version } from "@/lib/types";
import { Everything, KeyTerms, NeedsDecision, plural } from "../approve/sections";
import { Skeleton } from "../study/Skeleton";
import { keyTerms } from "./key-terms";
import { when } from "./questions";
import { useVersion } from "./useVersion";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const Live = ({ version }: { version: Version }) => (
  <Card className="flex flex-col items-start gap-3 p-6 sm:p-8">
    <span className="grid size-11 place-items-center rounded-full bg-ok-soft text-ok">
      <CircleCheck aria-hidden className="size-6" />
    </span>
    <h2 className="text-heading font-semibold tracking-tight">This rulebook is live</h2>
    <p className="text-body text-muted">
      {version.approvedBy ? `Approved by ${version.approvedBy}${version.approvedAt ? ` on ${when(version.approvedAt)}` : ""}.` : "It has been approved."} Its rules are now the ones used to check payments for this contract.
    </p>
    <div className="flex flex-wrap gap-2.5">
      <Link href={`/studies/${version.studyId}`} className={btnCls("primary")}>
        Back to the contract workspace
      </Link>
      <Link href={`/versions/${version.id}`} className={btnCls("secondary")}>
        See the summary
      </Link>
    </div>
  </Card>
);

function Replaced({ version }: { version: Version }) {
  const study = useQuery({ queryKey: keys.study(version.studyId), queryFn: () => api.study(version.studyId) });
  const newer = study.data?.versions.filter((v) => v.number > version.number).sort((a, b) => b.number - a.number)[0];
  return (
    <Card className="flex flex-col items-start gap-3 p-6 sm:p-8">
      <h2 className="text-title font-semibold tracking-tight">A newer version replaced this one</h2>
      <p className="text-body text-muted">This version can&apos;t be approved any more. Look at the newer version instead.</p>
      <Link href={newer ? `/versions/${newer.id}/approve` : `/studies/${version.studyId}`} className={btnCls("primary")}>
        {newer ? `Go to version ${newer.number}` : "Back to the contract workspace"}
      </Link>
    </Card>
  );
}

function Review({ version }: { version: Version }) {
  const qc = useQueryClient();
  const by = useActingAs();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const terms = useMemo(() => keyTerms(version), [version]);

  const blocking = (version.rulebook?.questions ?? []).filter((q) => q.state === "open" && q.blocking);
  const stuck = blocking.length + version.problems.length;
  const left = terms.filter((k) => !ticked.has(k.id)).length;

  const approve = useMutation({
    mutationFn: () =>
      api.approve(
        version.id,
        by!,
        terms.filter((k) => ticked.has(k.id)).map((k) => k.id),
      ),
    onSuccess: (v) => {
      qc.setQueryData(keys.version(v.id), v);
      void qc.invalidateQueries({ queryKey: keys.study(v.studyId) });
      void qc.invalidateQueries({ queryKey: keys.studies });
    },
  });

  const answerers = [...new Set(version.answers.map((a) => a.by))];
  // Maker-checker: the server enforces it too, so its refusal is shown the same way if the page was stale.
  const refused = approve.error instanceof ApiError && /can't also approve/i.test(approve.error.message);
  const waiting = refused || (by !== null && answerers.some((n) => same(n, by)));
  const why = waiting ? null : stuck ? "Sort out the decisions above first." : left ? `Tick the ${plural(left, "remaining key term")} first.` : null;

  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const click = () => {
    // Approval is recorded under a name, so ask who is approving before anything is sent.
    if (!by) askForPerson();
    else approve.mutate();
  };
  const shown = new Set(terms.map((k) => k.id));

  return (
    <div className="grid min-w-0 gap-5">
      <NeedsDecision version={version} blocking={blocking.map((q) => ({ id: q.id, question: q.question }))} problems={version.problems} />
      <KeyTerms version={version} terms={terms} ticked={ticked} onToggle={toggle} />
      <Everything version={version} shown={shown} />

      <Card className="flex flex-col items-start gap-3 p-5 sm:p-6">
        <h2 className="text-title font-semibold tracking-tight">Approve</h2>
        {waiting ? (
          <p className="max-w-[68ch] text-body text-ink-2">
            {answerers.length ? `${answerers.join(", ")} answered` : "Someone who answered"} this version&apos;s decisions, so someone else has to approve it. Ask a colleague to open this page.
          </p>
        ) : by ? (
          <p className="text-body text-muted">
            Approving as {by}.{answerers.length > 0 && ` ${answerers.join(", ")} answered the decisions.`} This rulebook becomes the live one for this contract.
          </p>
        ) : (
          <p className="text-body text-muted">
            Your name is recorded with the approval.{" "}
            <button type="button" onClick={() => askForPerson()} className="font-medium text-accent underline underline-offset-2">
              Choose your name
            </button>
          </p>
        )}
        {!refused && <ErrorNote error={approve.error} />}
        <Button variant="primary" size="lg" disabled={waiting || stuck > 0 || left > 0 || approve.isPending} onClick={click} aria-describedby={why ? "approve-why" : undefined}>
          {waiting ? "Waiting for a colleague" : approve.isPending ? "Approving…" : "Approve this rulebook"}
        </Button>
        {why && (
          <p id="approve-why" className="text-small text-muted">
            {why}
          </p>
        )}
      </Card>
    </div>
  );
}

function Loading() {
  return (
    <div aria-label="Loading this page" className="grid gap-5">
      <Skeleton className="h-24 w-full rounded-card" />
      <Skeleton className="h-72 w-full rounded-card" />
      <Skeleton className="h-32 w-full rounded-card" />
    </div>
  );
}

export function ApprovePanel({ versionId }: { versionId: string }) {
  const v = useVersion(versionId);
  const version = v.data;
  return (
    <div className={pageCls}>
      {v.isError ? (
        <LoadError error={v.error} retry={() => void v.refetch()} what="this version" />
      ) : !version ? (
        <Loading />
      ) : version.status === "approved" ? (
        <Live version={version} />
      ) : version.status === "superseded" ? (
        <Replaced version={version} />
      ) : version.status === "draft" && version.rulebook ? (
        <Review version={version} />
      ) : (
        <Card className="p-6 text-body text-muted sm:p-8">This version can&apos;t be approved until the contract has been read.</Card>
      )}
    </div>
  );
}
