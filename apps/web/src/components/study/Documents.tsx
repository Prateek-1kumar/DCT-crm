"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { useState } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Study, StudyDocument } from "@/lib/types";
import { btnCls, Button, Card, Dialog, ErrorNote, Spinner } from "../ui";
import { fileSize, pageList } from "./format";
import { FileDrop, sortFiles } from "./FileDrop";
import { useUpload } from "./useUpload";

function RemoveDocument({ study, doc, onClose }: { study: Study; doc: StudyDocument; onClose: () => void }) {
  const by = useActingAs();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeDocument(study.id, doc.id, by!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.study(study.id) });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Remove this document?">
      <p className="text-body text-muted">
        <span className="font-medium text-ink">{doc.name}</span> will be taken out of this contract. You can upload it again later.
      </p>
      <div className="mt-4">
        <ErrorNote error={remove.error} />
      </div>
      <div className="mt-6 flex justify-end gap-2.5">
        <Button onClick={onClose}>Keep it</Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          data-autofocus
          onClick={() => (by ? remove.mutate() : askForPerson())}
        >
          {remove.isPending ? "Removing…" : "Remove document"}
        </Button>
      </div>
    </Dialog>
  );
}

function ScannedPages({ doc }: { doc: StudyDocument }) {
  const { scannedPages: unread, scansRead: read } = doc;
  return (
    <>
      {read.length > 0 && <p className="text-small text-muted">Scanned {pageList(read).toLowerCase()} {read.length === 1 ? "was" : "were"} read from the image.</p>}
      {unread.length > 0 && (
        <p className="text-small text-muted">
          Scanned {pageList(unread).toLowerCase()} {unread.length === 1 ? "is" : "are"} read from the image when the read starts. Scanned pages take longer to read.
        </p>
      )}
    </>
  );
}

export function Documents({ study }: { study: Study }) {
  const by = useActingAs();
  const [removing, setRemoving] = useState<StudyDocument | null>(null);
  // files turned away before any upload: not a PDF, too big, or already in this contract
  const [skipped, setSkipped] = useState<string[]>([]);
  const upload = useUpload();

  function send(files: File[]) {
    if (!by) return askForPerson();
    const { pdfs, skipped: left } = sortFiles(files, study.documents.map((d) => ({ name: d.name, size: d.bytes })));
    setSkipped(left);
    if (pdfs.length) upload.mutate({ studyId: study.id, files: pdfs });
  }

  return (
    <Card className="p-6">
      <h2 className="text-title font-semibold tracking-tight">Documents</h2>
      <p className="mt-1 text-body text-muted">The signed contract and any amendments.</p>
      {study.documents.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {study.documents.map((doc) => (
            <li key={doc.id} className="flex flex-col gap-2 py-3">
              <div className="flex items-center gap-3">
                <FileText aria-hidden className="size-4 shrink-0 text-muted" />
                <span title={doc.name} className="min-w-0 flex-1 truncate text-body font-medium">
                  {doc.name}
                </span>
                <span className="shrink-0 text-small text-muted">
                  {doc.pageCount} {doc.pageCount === 1 ? "page" : "pages"} · {fileSize(doc.bytes)}
                </span>
                {/* a plain link: the browser saves the file under the name the API gives it */}
                <a href={`/api/v1/documents/${doc.id}/file`} download={doc.name} aria-label={`Download ${doc.name}`} data-noprint className={btnCls("ghost", "sm")}>
                  <Download aria-hidden className="size-4" strokeWidth={1.75} />
                  Download
                </a>
                <Button variant="ghost" size="sm" data-noprint onClick={() => setRemoving(doc)} aria-label={`Remove ${doc.name}`}>
                  Remove
                </Button>
              </div>
              <ScannedPages doc={doc} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <FileDrop compact onFiles={send} disabled={upload.isPending}>
          {upload.isPending && <Spinner label="Uploading" />}
        </FileDrop>
      </div>
      {(skipped.length > 0 || (upload.data && upload.data.length > 0)) && (
        <ul className="mt-3 flex flex-col gap-2">
          {[...skipped.map((text) => ({ text, problem: false })), ...(upload.data ?? [])].map(({ text, problem }) => (
            <li key={text}>{problem ? <ErrorNote>{text}</ErrorNote> : <p className="rounded-field bg-sunken px-4 py-3 text-body text-muted">{text}</p>}</li>
          ))}
        </ul>
      )}
      {removing && <RemoveDocument study={study} doc={removing} onClose={() => setRemoving(null)} />}
    </Card>
  );
}
