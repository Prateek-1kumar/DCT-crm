"use client";

import type { ContractAnomaly, DiffEntry, RulebookVersionDto, StudyDetailDto } from "@dct/shared";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState, type CSSProperties } from "react";
import { AnomalyPanel, type AnomalyActions } from "@/components/AnomalyPanel";
import { DiffView } from "@/components/DiffView";
import { useRulebook } from "@/components/review-context";
import { RulebookView } from "@/components/RulebookView";
import { Badge, Button, Dialog, ErrorNote, Field, Spinner, StatusBadge, btnCls, cx, inputCls } from "@/components/ui";
import { Workspace } from "@/components/Workspace";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { findProv } from "@/lib/pointer";
import { useDiff, useInvalidateStudy, useSettings, useStudy, useVersion } from "@/lib/queries";
import { settleProgress, signOffState } from "@/lib/review";

/** Version under review: ?v=, else the newest draft, else the newest version. */
function pickVersion(study: StudyDetailDto, v: string | null): number | null {
  if (v) return Number(v);
  const sorted = [...study.versions].sort((a, b) => b.version - a.version);
  return (sorted.find((x) => x.status === "draft") ?? sorted[0])?.version ?? null;
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const study = useStudy(id);
  const vnum = study.data ? pickVersion(study.data, sp.get("v")) : null;
  const version = useVersion(id, vnum);

  if (study.error || version.error) return <div className="p-6"><ErrorNote error={study.error ?? version.error} /></div>;
  if (!study.data || (vnum !== null && !version.data)) return <div className="p-6"><Spinner /></div>;
  if (vnum === null || !version.data) return <div className="p-6"><ErrorNote>This study has no rulebook version yet.</ErrorNote></div>;
  return <Review study={study.data} version={version.data} />;
}

function Review({ study, version }: { study: StudyDetailDto; version: RulebookVersionDto }) {
  const by = useActingAs();
  const settings = useSettings();
  const invalidate = useInvalidateStudy();
  const [signing, setSigning] = useState(false);
  const live = study.versions.filter((v) => v.status === "signed" && v.version !== version.version).sort((a, b) => b.version - a.version)[0];
  const isAmendment = !!live && version.version > live.version;
  const draft = version.status === "draft";
  const gate = signOffState(version, settings.data, by);
  const { settled, total } = settleProgress(version.anomalies);

  const actions: AnomalyActions = {
    resolve: async (a: ContractAnomaly, kind, note) => {
      await api.resolveAnomaly(study.id, version.version, a.id, { kind, note, by: by! });
      await invalidate(study.id);
    },
    chooseGrid: async (gridId, note) => {
      await api.chooseGrid(study.id, version.version, { gridId, note, by: by! });
      await invalidate(study.id);
    },
  };

  if (version.status === "extracting")
    return (
      <div className="mx-auto max-w-xl p-10">
        <Spinner label={`Version ${version.version} is still being extracted. This page updates when it's ready`} />
      </div>
    );
  if (version.status === "failed" || !version.rulebook)
    return (
      <div className="mx-auto max-w-xl p-10">
        <ErrorNote>Extraction of version {version.version} failed. Open the study to retry or enter the terms manually.</ErrorNote>
        <Link href={`/studies/${study.id}`} className={cx(btnCls(), "mt-4")}>
          Open study
        </Link>
      </div>
    );

  return (
    <div className="flex flex-1 flex-col" style={{ "--bar": "3.75rem" } as CSSProperties}>
      <div className="sticky top-14 z-20 flex h-[3.75rem] items-center gap-4 border-b border-line bg-surface px-5">
        <Link href={`/studies/${study.id}`} className="text-sm text-muted hover:text-ink" aria-label="Back to study">
          ←
        </Link>
        <div className="min-w-0">
          <p className="truncate font-semibold">
            {study.sponsor} <span className="num font-normal text-muted">· {study.protocol}</span>
          </p>
          <p className="flex items-center gap-2 text-xs text-muted">
            <StatusBadge status={study.status} />
            Version {version.version} · {version.status}
            {isAmendment && <Badge tone="accent">Amendment · diff vs live v{live!.version}</Badge>}
            {version.editors.length > 0 && <span>· corrected by {version.editors.join(", ")}</span>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {total > 0 && (
            <span className="num text-sm whitespace-nowrap">
              <strong className={settled === total ? "text-ok" : ""}>{settled}</strong> of {total} anomalies settled
            </span>
          )}
          {draft && (
            <div className="relative">
              <Button variant="primary" disabled={!gate.allowed} onClick={() => setSigning(true)} aria-describedby={gate.allowed ? undefined : "signoff-why"}>
                Sign off v{version.version}
              </Button>
            </div>
          )}
        </div>
      </div>
      {draft && !gate.allowed && (
        <p id="signoff-why" className="border-b border-line bg-warn-soft px-5 py-1.5 text-xs text-warn">
          Sign-off is locked: {gate.reasons.join(" ")}
        </p>
      )}
      {!draft && (
        <p className="border-b border-line bg-sunken px-5 py-1.5 text-xs text-muted">
          Version {version.version} is {version.status}
          {version.signedBy ? ` — signed by ${version.signedBy}` : ""}. It can&apos;t be changed.
        </p>
      )}

      <Workspace study={study} version={version} editable={draft}>
        <div className="flex flex-col gap-5">
          <AnomalyPanel anomalies={version.anomalies} actions={actions} />
          {isAmendment ? <AmendmentDiff study={study} version={version.version} against={live!.version} /> : <RulebookView />}
        </div>
      </Workspace>

      <SignOffDialog open={signing} onClose={() => setSigning(false)} study={study} version={version} />
    </div>
  );
}

function AmendmentDiff({ study, version, against }: { study: StudyDetailDto; version: number; against: number }) {
  const diff = useDiff(study.id, version, against);
  const { rulebook, show } = useRulebook();
  const [full, setFull] = useState(false);
  const onShow = (e: DiffEntry) => show(e.path, findProv(rulebook, e.path), e.label);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">What this amendment changes</h2>
        <span className="text-sm text-muted">Only differences from live v{against} are shown. v{against} stays live until this is signed.</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setFull((f) => !f)} aria-pressed={full}>
          {full ? "Show changes only" : "Show full rulebook"}
        </Button>
      </div>
      {full ? <RulebookView /> : diff.data ? <DiffView entries={diff.data} onShow={onShow} /> : diff.error ? <ErrorNote error={diff.error} /> : <Spinner />}
    </div>
  );
}

function SignOffDialog({ open, onClose, study, version }: { open: boolean; onClose: () => void; study: StudyDetailDto; version: RulebookVersionDto }) {
  const me = useActingAs();
  const settings = useSettings();
  const [name, setName] = useState<string>("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateStudy();
  const router = useRouter();
  const signer = name || me || "";
  const gate = signOffState(version, settings.data, signer || null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.signOff(study.id, version.version, { by: signer, ...(note.trim() ? { note: note.trim() } : {}) });
      await invalidate(study.id);
      onClose();
      router.push(`/studies/${study.id}?signed=${version.version}`);
    } catch (e) {
      setError(e); // 409s from the API carry a readable message
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Sign off version ${version.version}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-muted">
          Signing makes this rulebook live for {study.sponsor} {study.protocol}. It is then locked; later changes need an amendment. Your name, the time and
          your note are recorded in the audit log.
        </p>
        <Field label="Signing as" htmlFor="so-name">
          <select id="so-name" className={inputCls} value={signer} onChange={(e) => setName(e.target.value)}>
            <option value="">Choose…</option>
            {settings.data?.people.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)" htmlFor="so-note">
          <textarea id="so-note" rows={3} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the next reader should know" />
        </Field>
        {!gate.allowed && <ErrorNote>{gate.reasons.join(" ")}</ErrorNote>}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!gate.allowed || busy}>
            {busy ? "Signing…" : "Sign off and make live"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
