"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Badge, Button, btnCls, Card, ErrorNote, pageCls, Spinner, type Tone } from "@/components/ui";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { ApiError } from "@/lib/api";
import { api, keys } from "@/lib/queries";
import type { Version } from "@/lib/types";
import { keyTerms } from "./key-terms";
import { questionCounts, when } from "./questions";
import { useVersion } from "./useVersion";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Step({ n, title, tone, status, children }: { n: number; title: string; tone: Tone; status: string; children?: ReactNode }) {
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title font-semibold tracking-tight">
          {n}. {title}
        </h2>
        <Badge tone={tone}>{status}</Badge>
      </div>
      {children && <div className="mt-3 text-body text-ink-2">{children}</div>}
    </Card>
  );
}

const Live = ({ version }: { version: Version }) => (
  <Card className="flex flex-col items-start gap-3 p-8">
    <h2 className="text-heading font-semibold tracking-tight">This rulebook is live</h2>
    <p className="text-body text-muted">{version.approvedBy ? `Approved by ${version.approvedBy}${version.approvedAt ? ` on ${when(version.approvedAt)}` : ""}.` : "It has been approved."}</p>
    <Link href={`/versions/${version.id}`} className={btnCls("primary")}>
      Go to the summary
    </Link>
  </Card>
);

function Checklist({ version }: { version: Version }) {
  const qc = useQueryClient();
  const by = useActingAs();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const coverage = useQuery({ queryKey: keys.coverage(version.id), queryFn: () => api.coverage(version.id) });
  const terms = keyTerms(version.rulebook!);
  const { must, look } = questionCounts(version);
  const docId = (name: string) => version.documents.find((d) => d.name === name)?.id;
  const t = coverage.data?.totals;

  const approve = useMutation({
    mutationFn: () => api.approve(version.id, by!, terms.filter((k) => ticked.has(k.id)).map((k) => k.id)),
    onSuccess: (v) => {
      qc.setQueryData(keys.version(v.id), v);
      void qc.invalidateQueries({ queryKey: keys.version(v.id) });
    },
  });
  const answerers = [...new Set(version.answers.map((a) => a.by))];
  const sameHands = approve.error instanceof ApiError && /can't also approve/i.test(approve.error.message);

  const ready = must === 0 && version.problems.length === 0 && ticked.size === terms.length && !!by;
  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="grid gap-5">
      <Step n={1} title="Questions" tone={must ? "warn" : "ok"} status={must ? `${plural(must, "question")} still to answer` : "All answered"}>
        {must > 0 && (
          <Link href={`/versions/${version.id}/questions`} className="font-medium text-accent hover:text-accent-hover">
            Answer them first
          </Link>
        )}
        {look > 0 && <p>{plural(look, "other question")} worth a look. You can approve without answering {look === 1 ? "it" : "them"}.</p>}
      </Step>

      <Step n={2} title="Problems the checks still find" tone={version.problems.length ? "danger" : "ok"} status={version.problems.length ? plural(version.problems.length, "problem") : "None"}>
        {version.problems.length > 0 && (
          <ul className="list-disc space-y-1 pl-5">
            {version.problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        )}
      </Step>

      <Step n={3} title="Every amount in the contract" tone={!t ? "neutral" : t.missing ? "danger" : "ok"} status={t ? (t.missing ? `${t.missing} missing` : "Nothing missing") : "Checking"}>
        {coverage.isError && <ErrorNote error={coverage.error} retry={() => void coverage.refetch()} />}
        {coverage.isPending && <Spinner />}
        {t && (
          <p>
            {t.amounts} amounts in the contract: {t.captured + t.decided} captured, {t.setAside} set aside, {t.missing} missing.{" "}
            <Link href={`/versions/${version.id}/proof`} className="font-medium text-accent hover:text-accent-hover">
              See the proof
            </Link>
          </p>
        )}
      </Step>

      <Step n={4} title="Key terms: tick each one you checked against the contract" tone={ticked.size === terms.length ? "ok" : "warn"} status={`${ticked.size} of ${terms.length} ticked`}>
        <ul className="divide-y divide-line">
          {terms.map((k) => {
            const doc = docId(k.doc);
            return (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-1 size-4 accent-primary" checked={ticked.has(k.id)} onChange={() => toggle(k.id)} />
                  <span>
                    <span className="block font-medium">{k.label}</span>
                    <span className="block text-muted">{k.value}</span>
                  </span>
                </label>
                {doc && (
                  <Link href={`/versions/${version.id}/proof?doc=${doc}&page=${k.page}`} className="text-small font-medium text-accent hover:text-accent-hover">
                    Show in contract
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </Step>

      <Card className="flex flex-col items-start gap-3 p-6">
        <h2 className="text-title font-semibold tracking-tight">5. Approve</h2>
        {by ? <p className="text-body text-muted">Approving as {by}. This rulebook becomes the live one for this study.</p> : (
          <p className="text-body text-muted">
            Your name is recorded with the approval.{" "}
            <button type="button" onClick={() => askForPerson()} className="font-medium text-accent underline underline-offset-2">
              Choose your name
            </button>
          </p>
        )}
        {sameHands ? (
          <ErrorNote>
            Someone who answered this version&apos;s questions can&apos;t also approve it.
            {answerers.length > 0 && ` Answered by ${answerers.join(", ")}.`} Ask a colleague to approve it.
          </ErrorNote>
        ) : (
          <ErrorNote error={approve.error} />
        )}
        <Button variant="primary" size="lg" disabled={!ready || approve.isPending} onClick={() => approve.mutate()}>
          Approve this rulebook
        </Button>
      </Card>
    </div>
  );
}

export function ApprovePanel({ versionId }: { versionId: string }) {
  const { data: version } = useVersion(versionId);
  return (
    <div className={pageCls}>
      {!version ? (
        <Spinner />
      ) : version.status === "approved" ? (
        <Live version={version} />
      ) : version.status === "draft" && version.rulebook ? (
        <Checklist version={version} />
      ) : (
        <Card className="p-8 text-body text-muted">A newer version replaced this one, so it can&apos;t be approved.</Card>
      )}
    </div>
  );
}
