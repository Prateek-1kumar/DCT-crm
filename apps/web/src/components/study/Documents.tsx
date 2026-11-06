"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useState, type RefObject } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Study, StudyDocument } from "@/lib/types";
import { Button, Card, Dialog, ErrorNote, Spinner } from "../ui";
import { fileSize, pageList } from "./format";
import { PdfDrop } from "./PdfDrop";
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
  const scanned = doc.scannedPages;
  if (scanned.length === 0) return null;
  return (
    <p className="text-small text-muted">
      Scanned {pageList(scanned).toLowerCase()} {scanned.length === 1 ? "is" : "are"} read from the image when the read starts (about $0.40 a page, the first time only).
    </p>
  );
}

export function Documents({ study, inputRef }: { study: Study; inputRef: RefObject<HTMLInputElement | null> }) {
  const by = useActingAs();
  const [removing, setRemoving] = useState<StudyDocument | null>(null);
  const upload = useUpload();

  function send(files: File[]) {
    if (!by) return askForPerson();
    upload.mutate({ studyId: study.id, files });
  }

  return (
    <Card className="p-6">
      <h2 className="text-title font-semibold tracking-tight">Documents</h2>
      {study.documents.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {study.documents.map((doc) => (
            <li key={doc.id} className="flex flex-col gap-2 py-3">
              <div className="flex items-center gap-3">
                <FileText aria-hidden className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-body font-medium">{doc.name}</span>
                <span className="text-small text-muted">
                  {doc.pageCount} {doc.pageCount === 1 ? "page" : "pages"} · {fileSize(doc.bytes)}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(doc)} aria-label={`Remove ${doc.name}`}>
                  Remove
                </Button>
              </div>
              <ScannedPages doc={doc} />
            </li>
          ))}
        </ul>
      )}
      <PdfDrop className="mt-4" onFiles={send} disabled={upload.isPending} inputRef={inputRef}>
        {upload.isPending && <Spinner label="Uploading" />}
      </PdfDrop>
      {upload.data && upload.data.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {upload.data.map(({ text, problem }) => (
            <li key={text}>{problem ? <ErrorNote>{text}</ErrorNote> : <p className="rounded-field bg-sunken px-4 py-3 text-body text-muted">{text}</p>}</li>
          ))}
        </ul>
      )}
      {removing && <RemoveDocument study={study} doc={removing} onClose={() => setRemoving(null)} />}
    </Card>
  );
}
