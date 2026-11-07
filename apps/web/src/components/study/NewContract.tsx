"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { Button, Card, ErrorNote, pageCls, Spinner } from "../ui";
import { fileSize, pageList } from "./format";
import { FileDrop, sortFiles } from "./FileDrop";
import { StartReading } from "./StartReading";
import { useUpload, type Note, type Row } from "./useUpload";

const STATUS = { waiting: "Waiting", sending: "Uploading…", added: "Added", failed: "Couldn't add" };

function FileRow({ row, onRemove }: { row: Row; onRemove?: () => void }) {
  const scans = row.scannedPages ?? [];
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex items-center gap-3 text-body">
        <FileText aria-hidden className="size-4 shrink-0 text-muted" />
        <span title={row.name} className="min-w-0 flex-1 truncate font-medium">
          {row.name}
        </span>
        <span className="shrink-0 text-small text-muted">
          {row.pages !== undefined && `${row.pages} ${row.pages === 1 ? "page" : "pages"} · `}
          {fileSize(row.size)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-small text-muted">
          {row.status === "added" && <Check aria-hidden className="size-4 text-ok" />}
          {STATUS[row.status]}
        </span>
        {onRemove && (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${row.name}`} onClick={onRemove}>
            <X aria-hidden className="size-4" />
          </Button>
        )}
      </div>
      {scans.length > 0 && (
        <p className="pl-7 text-small text-muted">
          {pageList(scans)} {scans.length === 1 ? "is a scan" : "are scans"}. Scanned pages take longer to read.
        </p>
      )}
    </li>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One page: drop the PDFs, see what arrived, start reading. The contract is created with the first file dropped. */
export function NewContract() {
  const router = useRouter();
  const by = useActingAs();
  const queryClient = useQueryClient();
  const upload = useUpload();
  const [studyId, setStudyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  // files turned away before any upload: not a PDF, too big, or already listed
  const [skipped, setSkipped] = useState<string[]>([]);

  const add = useMutation({
    mutationFn: async (files: File[]) => {
      let id = studyId;
      if (!id) {
        id = (await api.createStudy({ by: by! })).id;
        setStudyId(id);
        void queryClient.invalidateQueries({ queryKey: keys.studies });
      }
      return upload.mutateAsync({ studyId: id, files });
    },
    onSuccess: (fresh) => setNotes((n) => [...n, ...fresh]),
  });

  function send(files: File[]) {
    if (!by) return askForPerson();
    const { pdfs, skipped: left } = sortFiles(files, upload.rows.filter((r) => r.status !== "failed"));
    setSkipped((s) => [...new Set([...s, ...left])]);
    // nothing to send means no contract is created for a drop of the wrong kind of file
    if (pdfs.length) add.mutate(pdfs);
  }

  const busy = add.isPending || upload.remove.isPending;
  const added = upload.rows.filter((r) => r.status === "added");
  const pages = added.reduce((n, r) => n + (r.pages ?? 0), 0);
  const scanned = added.reduce((n, r) => n + (r.scannedPages?.length ?? 0), 0);
  return (
    <div className={pageCls}>
      <div className="mx-auto flex w-full max-w-[720px] flex-col items-center gap-6 sm:pt-8">
        <header className="text-center">
          <h1 className="text-display font-semibold tracking-[-0.025em]">Add contract</h1>
          <p className="mt-2 text-lead text-muted">Drop the signed contract and any amendments. We&apos;ll read the study details from them.</p>
        </header>

        <FileDrop compact={upload.rows.length > 0} onFiles={send} disabled={busy}>
          {busy && <Spinner label={upload.remove.isPending ? "Removing" : studyId ? "Uploading" : "Setting up the contract"} />}
        </FileDrop>
        <div className="flex w-full flex-col gap-3 text-left">
          <ErrorNote error={add.error} />
          <ErrorNote error={upload.remove.error} />
          {skipped.map((text) => (
            <p key={text} className="rounded-field bg-sunken px-4 py-3 text-body text-muted">
              {text}
            </p>
          ))}
        </div>

        {upload.rows.length > 0 && (
          <Card className="w-full px-6 py-2 text-left">
            <ul className="divide-y divide-line">
              {upload.rows.map((row, i) => (
                <FileRow key={`${row.name}-${i}`} row={row} onRemove={row.status === "added" && row.id && studyId && !busy ? () => upload.remove.mutate({ studyId, id: row.id! }) : undefined} />
              ))}
            </ul>
          </Card>
        )}

        <div className="flex w-full flex-col gap-3 text-left">
          {notes.map(({ text, problem }) => (
            <div key={text}>{problem ? <ErrorNote>{text}</ErrorNote> : <p className="rounded-field bg-sunken px-4 py-3 text-body text-muted">{text}</p>}</div>
          ))}
        </div>

        {studyId && (
          <div className="flex flex-col items-center gap-3 text-center">
            {added.length > 0 && (
              <p className="text-body text-ink-2" aria-live="polite">
                {plural(added.length, "file")} · {plural(pages, "page")}
                {scanned > 0 && ` · ${scanned} scanned`}
              </p>
            )}
            <StartReading studyId={studyId} label="Start reading" disabled={busy || added.length === 0} onStarted={() => router.push(`/studies/${studyId}`)} />
            <p className="max-w-md text-small text-muted">We read every page, then ask you about anything we can&apos;t settle ourselves. You can leave while we read.</p>
          </div>
        )}
      </div>
    </div>
  );
}
