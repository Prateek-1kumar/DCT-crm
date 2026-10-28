"use client";

import type { DocumentDto, DocumentKind } from "@dct/shared";
import { useMutation } from "@tanstack/react-query";
import { useState, type DragEvent } from "react";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { DOC_KIND_LABEL } from "@/lib/format";
import { Badge, Button, ErrorNote, cx } from "./ui";

/** Same as the API's per-file limit. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Drag-and-drop PDF upload. Calls onUploaded with what the API stored (incl. duplicates). */
export function Dropzone({ onUploaded, compact }: { onUploaded: (docs: DocumentDto[]) => void; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const by = useActingAs();
  // One request per file: one bad file doesn't sink the others, and each error names its file.
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const ok: DocumentDto[] = [];
      const errors: string[] = [];
      for (const f of files) {
        try {
          ok.push(...(await api.upload([f], by!)));
        } catch (e) {
          errors.push(e instanceof Error ? e.message : `${f.name}: upload failed`);
        }
      }
      setFailed(errors);
      return ok;
    },
    onSuccess: (docs) => {
      if (docs.length) onUploaded(docs);
    },
  });

  function take(list: FileList | null) {
    const files = Array.from(list ?? []);
    const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const small = pdfs.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    setRejected([
      ...files.filter((f) => !pdfs.includes(f)).map((f) => `${f.name} (not a PDF)`),
      ...pdfs.filter((f) => !small.includes(f)).map((f) => `${f.name} (over 50 MB)`),
    ]);
    setFailed([]);
    if (small.length && by) upload.mutate(small);
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
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed text-center transition-colors focus-within:border-focus",
          compact ? "px-4 py-6" : "px-6 py-12",
          over ? "border-focus bg-accent-soft" : "border-line-strong bg-sunken hover:border-focus hover:bg-accent-soft",
        )}
      >
        <input type="file" accept="application/pdf,.pdf" multiple disabled={!by} className="sr-only" onChange={(e) => (take(e.target.files), (e.target.value = ""))} />
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="size-6 text-ink-2">
          <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
        </svg>
        <span className="font-medium">{!by ? "Choose your name under “Acting as” (top right) to upload" : upload.isPending ? "Uploading…" : "Drop the signed contract PDFs here, or click to choose"}</span>
        <span className="text-xs text-muted">The contract and its budget, plus any master agreement or amendment. The e-signed (DocuSign) PDF is best.</span>
      </label>
      {rejected.length > 0 && <ErrorNote>Only PDFs up to 50 MB can be uploaded. Skipped: {rejected.join(", ")}</ErrorNote>}
      {failed.map((m) => (
        <ErrorNote key={m}>{m}</ErrorNote>
      ))}
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
        aria-label={`Kind of file: ${doc.filename}`}
        value={doc.kind}
        disabled={!by || m.isPending}
        title={by ? "Change what kind of file this is" : "Choose your name under “Acting as” to change this"}
        onChange={(e) => m.mutate(e.target.value as DocumentKind)}
        className={cx(
          "h-7 rounded-full border-0 px-2.5 text-xs",
          doc.kind === "other" ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent",
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
    <ul className="divide-y divide-line rounded-card border border-line bg-surface shadow-card">
      {docs.map((d) => (
        <li key={d.id + (d.duplicateOf ? "-dup" : "")} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="size-4 flex-none text-muted">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
          </svg>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px]">{d.filename}</span>
            <span className="num text-xs text-muted">{d.pageCount} pages</span>
          </span>
          {d.duplicateOf ? (
            <Badge tone="warn" title="This exact file was uploaded before. It won't be added again.">
              Already uploaded
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
