"use client";

import type { DocumentDto } from "@dct/shared";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { NeedsPerson } from "@/components/AppHeader";
import { DocList, Dropzone } from "@/components/UploadDocs";
import { Button, ErrorNote, PageTitle, pageCls, Spinner, Stepper } from "@/components/ui";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { useInvalidateStudy, useStudy } from "@/lib/queries";

export default function AmendPage() {
  const { id } = useParams<{ id: string }>();
  const study = useStudy(id);
  const by = useActingAs();
  const router = useRouter();
  const invalidate = useInvalidateStudy();
  const [docs, setDocs] = useState<DocumentDto[]>([]);
  const fresh = docs.filter((d) => !d.duplicateOf);

  const start = useMutation({
    mutationFn: () => api.extract(id, by!, fresh.map((d) => d.id)),
    onSuccess: async (r) => {
      await invalidate(id);
      router.push(`/studies/${id}/reading?job=${encodeURIComponent(r.jobId)}&v=${r.version}`);
      setDocs([]);
    },
  });

  if (!study.data) return <div className="p-6">{study.error ? <ErrorNote error={study.error} /> : <Spinner />}</div>;
  const s = study.data;
  return (
    <div className={`${pageCls} max-w-[860px]`}>
      <p className="mb-3 text-[13px]">
        <Link href={`/studies/${id}`} className="text-muted hover:text-ink">
          ← {s.protocol} · {s.sponsor}
        </Link>
      </p>
      <PageTitle
        eyebrow="Amendment"
        title="Upload an amendment"
        sub={`Version ${s.liveVersion ?? "?"} stays live until the amended invoicing master is approved. You'll see what the amendment changes before approving.`}
      />
      <Stepper state={{ stage: "Upload" }} className="mb-6" />
      <div className="flex flex-col gap-4">
        <Dropzone compact onUploaded={(u) => setDocs((cur) => [...cur, ...u.filter((d) => !cur.some((c) => c.id === d.id))])} />
        <DocList docs={docs} onChange={(d) => setDocs((cur) => cur.map((x) => (x.id === d.id ? d : x)))} />
        {fresh.some((d) => d.kind !== "amendment") && <p className="text-sm text-warn">Check the kind of file: an amendment should be marked “Amendment”.</p>}
        <div className="flex items-center justify-end gap-3">
          {!by && <NeedsPerson />}
          <ErrorNote error={start.error} />
          <Button variant="primary" disabled={!fresh.length || !by || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? "Starting…" : "Start reading →"}
          </Button>
        </div>
      </div>
    </div>
  );
}
