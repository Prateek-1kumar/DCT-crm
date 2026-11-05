"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Badge, btnCls, Card, cx, LoadError, pageCls, Spinner, type Tone } from "@/components/ui";
import { api, keys } from "@/lib/queries";
import type { Version, VersionStatus } from "@/lib/types";
import { questionCounts } from "./questions";
import { useVersion } from "./useVersion";

const STATUS: Record<VersionStatus, { label: string; tone: Tone }> = {
  reading: { label: "Reading", tone: "accent" },
  draft: { label: "Draft", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  approved: { label: "Live", tone: "ok" },
  superseded: { label: "Superseded", tone: "neutral" },
};

const tabCls = (active: boolean) =>
  cx("inline-flex h-11 items-center gap-2 border-b-2 text-body font-medium whitespace-nowrap", active ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink");

function Tabs({ version }: { version: Version }) {
  const path = usePathname();
  const base = `/versions/${version.id}`;
  const { must, look } = questionCounts(version);
  const tabs = [
    { href: base, label: "Summary", extra: null },
    {
      href: `${base}/questions`,
      label: "Questions",
      extra: (
        <>
          {must > 0 && <Badge tone="warn">{must} to answer</Badge>}
          {look > 0 && <Badge>{look} worth a look</Badge>}
        </>
      ),
    },
    { href: `${base}/proof`, label: "Proof", extra: null },
    { href: `${base}/approve`, label: "Approve", extra: null },
  ];
  return (
    <nav aria-label="This version" className="mt-6 flex gap-6 overflow-x-auto border-b border-line">
      {tabs.map((t) => {
        const active = t.href === base ? path === base : path.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={tabCls(active)}>
            {t.label}
            {t.extra}
          </Link>
        );
      })}
    </nav>
  );
}

function Stopped({ version, studyHref }: { version: Version; studyHref: string }) {
  const reason = useQuery({ queryKey: keys.read(version.read?.id ?? ""), queryFn: () => api.read(version.read!.id), enabled: version.status === "failed" && !!version.read });
  const failed = version.status === "failed";
  return (
    <Card className="mt-8 flex flex-col items-start gap-3 p-8">
      <h2 className="text-title font-semibold tracking-tight">{failed ? "We couldn't finish reading this contract" : "We're still reading this contract"}</h2>
      <p className="text-body text-muted">
        {failed ? (reason.data?.error ?? "The reading stopped before it was done. Start a new one from the study page.") : "This page fills in when the reading is done. You can leave and come back."}
      </p>
      <Link href={studyHref} className={btnCls("primary")}>
        Go to the study
      </Link>
    </Card>
  );
}

/** The header and tabs every version screen sits under. */
export function VersionShell({ versionId, children }: { versionId: string; children: ReactNode }) {
  const v = useVersion(versionId);
  const studyId = v.data?.studyId;
  const study = useQuery({ queryKey: keys.study(studyId ?? ""), queryFn: () => api.study(studyId!), enabled: !!studyId });

  if (v.isPending)
    return (
      <div className={pageCls}>
        <Spinner />
      </div>
    );
  if (v.isError) return <LoadError error={v.error} retry={() => void v.refetch()} what="this version" />;

  const version = v.data;
  const studyHref = `/studies/${version.studyId}`;
  const { label, tone } = STATUS[version.status];
  const ready = version.status !== "reading" && version.status !== "failed";
  return (
    <>
      <header className="mx-auto w-full max-w-[1280px] px-6 pt-8 lg:px-10">
        <Link href={studyHref} className="text-small font-medium text-accent hover:text-accent-hover">
          ← {study.data?.protocol ?? "Back to the study"}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-display font-semibold tracking-[-0.025em]">Version {version.number}</h1>
          <Badge tone={tone} dot>
            {label}
          </Badge>
        </div>
        {ready ? <Tabs version={version} /> : <Stopped version={version} studyHref={studyHref} />}
      </header>
      {ready && children}
    </>
  );
}
