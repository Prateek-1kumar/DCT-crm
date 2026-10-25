"use client";

import type { DocumentDto, DocumentKind } from "@dct/shared";
import { useMutation } from "@tanstack/react-query";
import { useState, type DragEvent } from "react";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { DOC_KIND_LABEL } from "@/lib/format";
import { Badge, Button, ErrorNote, cx } from "./ui";

/** Drag-and-drop PDF upload. Calls onUploaded with what the API stored (incl. duplicates). */
export function Dropzone({ onUploaded, studyId, compact }: { onUploaded: (docs: DocumentDto[]) => void; studyId?: string; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const upload = useMutation({ mutationFn: (files: File[]) => api.upload(files, studyId), onSuccess: onUploaded });

  function take(list: FileList | null) {
    const files = Array.from(list ?? []);
    const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    setRejected(files.filter((f) => !pdfs.includes(f)).map((f) => f.name));
    if (pdfs.length) upload.mutate(pdfs);
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-2">
      <label
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cx(
          "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-card border-2 border-dashed text-center transition-colors focus-within:border-focus",
          compact ? "px-4 py-6" : "px-6 py-14",
          over ? "border-accent bg-accent-soft" : "border-line-strong bg-surface hover:border-accent",
        )}
      >
        <input type="file" accept="application/pdf,.pdf" multiple className="sr-only" onChange={(e) => (take(e.target.files), (e.target.value = ""))} />
        <span aria-hidden className="text-2xl text-faint">⇪</span>
        <span className="font-medium">{upload.isPending ? "Uploading…" : "Drop contract PDFs here, or click to choose"}</span>
        <span className="text-sm text-muted">Master agreement, work order, budget, adoption or amendment. Scans are fine.</span>
      </label>
      {rejected.length > 0 && <ErrorNote>Only PDFs can be uploaded. Skipped: {rejected.join(", ")}</ErrorNote>}
      <ErrorNote error={upload.error} />
    </div>
  );
}

export function KindSelect({ doc, onChanged }: { doc: DocumentDto; onChanged: (d: DocumentDto) => void }) {
  const by = useActingAs();
  const m = useMutation({ mutationFn: (kind: DocumentKind) => api.setDocumentKind(doc.id, kind, by!), onSuccess: onChanged });
  return (
    <span className="inline-flex items-center gap-1">
      <select
        aria-label={`Document kind for ${doc.filename}`}
        value={doc.kind}
        disabled={!by || m.isPending}
        title={by ? "Change the detected kind" : "Choose who you are acting as to change this"}
        onChange={(e) => m.mutate(e.target.value as DocumentKind)}
        className={cx(
          "h-7 rounded-full border px-2.5 text-xs font-medium",
          doc.kind === "other" ? "border-warn bg-warn-soft text-warn" : "border-transparent bg-accent-soft text-accent",
        )}
      >
        {Object.entries(DOC_KIND_LABEL).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      {m.error && <span className="text-xs text-danger">{m.error.message}</span>}
    </span>
  );
}

export function DocList({ docs, onChange, onRemove }: { docs: DocumentDto[]; onChange: (d: DocumentDto) => void; onRemove?: (id: string) => void }) {
  if (!docs.length) return null;
  return (
    <ul className="divide-y divide-line rounded-card border border-line bg-surface">
      {docs.map((d) => (
        <li key={d.id + (d.duplicateOf ? "-dup" : "")} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <span aria-hidden className="text-faint">▤</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{d.filename}</span>
            <span className="num text-xs text-muted">
              {d.pageCount} pages · sha256 {d.sha256.slice(0, 10)}…
            </span>
          </span>
          {d.duplicateOf ? (
            <Badge tone="warn" title="Same sha256 as a file already stored. It won't be added again.">
              Duplicate: already uploaded
            </Badge>
          ) : (
            <KindSelect doc={d} onChanged={onChange} />
          )}
          {onRemove && (
            <Button size="sm" variant="ghost" onClick={() => onRemove(d.id)} aria-label={`Remove ${d.filename}`}>
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
