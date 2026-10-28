"use client";

import type { DocumentDto, DocumentKind } from "@dct/shared";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Copy, FileCheck2, FileText, UploadCloud, X } from "lucide-react";
import { useState, type DragEvent } from "react";
import { askForPerson, useActingAs } from "@/lib/acting-as";
import { api } from "@/lib/api";
import { DOC_KIND_LABEL } from "@/lib/format";
import { Badge, Button, cx, ErrorNote } from "./ui";

/** Same as the API's per-file limit. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Drag-and-drop PDF upload, one request per file. Calls onUploaded with what the API stored (incl. duplicates). */
export function Dropzone({ onUploaded, compact }: { onUploaded: (docs: DocumentDto[]) => void; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const by = useActingAs();
  // One request per file: one bad file doesn't sink the others, and each error names its file.
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const ok: DocumentDto[] = [];
      const errors: string[] = [];
      for (const [i, f] of files.entries()) {
        setProgress({ done: i, of: files.length });
        try {
          ok.push(...(await api.upload([f], by!)));
        } catch (e) {
          errors.push(e instanceof Error ? e.message : `${f.name}: upload failed`);
        }
      }
      setProgress(null);
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
    if (!by) return askForPerson();
    take(e.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-3">
      <label
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={(e) => {
          if (!by) {
            e.preventDefault();
            askForPerson();
          }
        }}
        className={cx(
          "group flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed text-center transition-colors focus-within:border-brand",
          compact ? "gap-2 px-5 py-7" : "gap-3 px-6 py-14",
          over ? "border-brand bg-brand-soft" : "border-line-strong bg-sunken/60 hover:border-brand/60 hover:bg-brand-soft/40",
        )}
      >
        <input type="file" accept="application/pdf,.pdf" multiple className="sr-only" onChange={(e) => (take(e.target.files), (e.target.value = ""))} />
        <span className={cx("grid place-items-center rounded-tile bg-surface text-brand shadow-button ring-1 ring-ink/[0.05] transition-transform group-hover:-translate-y-0.5", compact ? "size-11" : "size-14")}>
          {upload.isPending ? (
            <span aria-hidden className="size-5 animate-spin rounded-full border-2 border-brand/25 border-t-brand" />
          ) : (
            <UploadCloud className={compact ? "size-5" : "size-6"} strokeWidth={1.75} />
          )}
        </span>
        <span className={cx("font-semibold tracking-tight", compact ? "text-body" : "text-title")}>
          {upload.isPending
            ? `Uploading${progress && progress.of > 1 ? ` ${progress.done + 1} of ${progress.of}` : ""}…`
            : over
              ? "Drop to upload"
              : (
                  <>
                    <span className="pointer-coarse:hidden">Drop the contract PDFs here</span>
                    <span className="hidden pointer-coarse:inline">Choose the contract PDFs</span>
                  </>
                )}
        </span>
        {!upload.isPending && (
          <span className="text-body text-muted">
            <span className="pointer-coarse:hidden">
              or <span className="font-medium text-accent underline-offset-2 group-hover:underline">choose files</span> ·{" "}
            </span>
            PDF, up to 50 MB each
          </span>
        )}
        {!compact && !upload.isPending && (
          <span className="mt-1 max-w-[52ch] text-small text-faint">Add the signed contract and its budget, plus any master agreement or amendment. The DocuSign copy is best: its numbers can be checked automatically.</span>
        )}
      </label>
      {rejected.length > 0 && <ErrorNote>Only PDFs up to 50 MB can be added. Skipped: {rejected.join(", ")}</ErrorNote>}
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
    <span className="inline-flex flex-col items-end gap-1">
      <label className="relative">
        <span className="sr-only">What kind of file {doc.filename} is</span>
        <select
          value={doc.kind}
          disabled={!by || m.isPending}
          title={by ? "Change what kind of file this is" : "Choose your name first to change this"}
          onChange={(e) => m.mutate(e.target.value as DocumentKind)}
          className={cx(
            "h-8 cursor-pointer appearance-none rounded-full pr-8 pl-3 text-small font-medium transition-colors disabled:cursor-default",
            doc.kind === "other" ? "bg-warn-soft text-warn" : "bg-brand-soft text-accent hover:bg-brand/15",
          )}
        >
          {Object.entries(DOC_KIND_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 opacity-70" strokeWidth={2.25} />
      </label>
      {m.error && <span className="text-caption text-danger">{m.error.message}</span>}
    </span>
  );
}

/** One card per file: what it is, pages, whether its numbers can be checked against its text. */
export function DocList({ docs, onChange, onRemove }: { docs: DocumentDto[]; onChange: (d: DocumentDto) => void; onRemove?: (id: string) => void }) {
  if (!docs.length) return null;
  return (
    <ul className="flex flex-col gap-2.5">
      {docs.map((d) => {
        const scan = d.text === "scan" && !d.duplicateOf;
        return (
          <li key={d.id + (d.duplicateOf ? "-dup" : "")} className={cx("rounded-tile bg-surface ring-1", scan ? "ring-warn/30" : "ring-line")}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
              <span className={cx("grid size-10 shrink-0 place-items-center rounded-[12px]", d.duplicateOf ? "bg-ink/[0.05] text-faint" : scan ? "bg-warn-soft text-warn" : "bg-brand-soft text-accent")}>
                {d.duplicateOf ? <Copy className="size-[18px]" strokeWidth={1.75} /> : d.text === "text" ? <FileCheck2 className="size-[18px]" strokeWidth={1.75} /> : <FileText className="size-[18px]" strokeWidth={1.75} />}
              </span>
              {/* Keeps its width on narrow screens; the kind menu wraps below instead of squeezing the name. */}
              <span className="min-w-0 flex-[1_1_14rem]">
                <span className="block truncate text-body font-medium">{d.filename}</span>
                <span className="num flex flex-wrap items-center gap-x-2 text-small text-muted">
                  {d.pageCount} {d.pageCount === 1 ? "page" : "pages"}
                  {d.text === "text" && !d.duplicateOf && <span className="text-ok">· Text PDF, numbers can be checked</span>}
                  {scan && <span className="text-warn">· Scan</span>}
                </span>
              </span>
              {d.duplicateOf ? (
                <Badge title="This exact file was added before. It won't be added again.">Already added</Badge>
              ) : (
                <KindSelect doc={d} onChanged={onChange} />
              )}
              {onRemove && (
                <Button size="icon-sm" variant="ghost" onClick={() => onRemove(d.id)} aria-label={`Remove ${d.filename}`}>
                  <X className="size-4" strokeWidth={2} />
                </Button>
              )}
            </div>
            {scan && (
              <p className="flex items-start gap-2.5 border-t border-warn/20 bg-warn-soft/60 px-4 py-3 text-small text-ink-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
                <span>
                  This file is a scan, so its numbers can&apos;t be checked against its text and you&apos;ll confirm more of them by hand. If you have the signed
                  DocuSign copy, {onRemove ? "remove this one and add that instead." : "add that instead."}
                </span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
