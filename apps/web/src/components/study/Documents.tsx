"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileText } from "lucide-react";
import { useState, type DragEvent, type RefObject } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Study, StudyDocument } from "@/lib/types";
import { Button, Card, cx, Dialog, errorText, ErrorNote, Spinner } from "../ui";
import { fileSize, scanWarning } from "./format";

const failure = (file: File, error: unknown) => {
  const message = errorText(error);
  return message.includes(file.name) ? message : `${file.name}: ${message}`;
};

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

export function Documents({ study, inputRef }: { study: Study; inputRef: RefObject<HTMLInputElement | null> }) {
  const by = useActingAs();
  const queryClient = useQueryClient();
  const [over, setOver] = useState(false);
  const [removing, setRemoving] = useState<StudyDocument | null>(null);

  // One file per request: each is checked on its own, and a bad one doesn't sink the others.
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const notes: { text: string; problem: boolean }[] = [];
      for (const file of files) {
        try {
          const [result] = await api.upload(study.id, [file], by!);
          if (result?.alreadyInStudy) notes.push({ text: `${file.name} was already in this contract, so it wasn't added again.`, problem: false });
        } catch (error) {
          notes.push({ text: failure(file, error), problem: true });
        }
      }
      return notes;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.study(study.id) }),
  });

  function send(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    if (!by) return askForPerson();
    upload.mutate(files);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    send(e.dataTransfer.files);
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
              {doc.scannedPages.length > 0 && (
                <p className="flex gap-2 rounded-field bg-warn-soft px-3.5 py-2.5 text-small text-warn">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {scanWarning(doc.scannedPages)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cx("mt-4 flex flex-col items-center gap-3 rounded-tile border border-dashed px-6 py-8 text-center", over ? "border-brand bg-brand-soft" : "border-line-strong bg-sunken")}
      >
        <p className="text-body text-muted">Drop contract PDFs here, or choose them from your computer. You can add several at once.</p>
        <Button disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
          Choose PDFs
        </Button>
        <input ref={inputRef} hidden type="file" multiple accept="application/pdf,.pdf" aria-label="Contract PDFs" onChange={(e) => { send(e.target.files); e.target.value = ""; }} />
        {upload.isPending && <Spinner label="Uploading" />}
      </div>
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
