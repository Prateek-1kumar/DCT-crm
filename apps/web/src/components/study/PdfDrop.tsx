"use client";

import { useState, type ReactNode, type RefObject } from "react";
import { cx, Button } from "../ui";

export function PdfDrop({ onFiles, disabled, inputRef, className, children }: { onFiles: (files: File[]) => void; disabled?: boolean; inputRef: RefObject<HTMLInputElement | null>; className?: string; children?: ReactNode }) {
  const [over, setOver] = useState(false);

  function send(list: FileList | null) {
    const files = [...(list ?? [])];
    if (files.length) onFiles(files);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        send(e.dataTransfer.files);
      }}
      className={cx("flex flex-col items-center gap-3 rounded-tile border border-dashed px-6 py-8 text-center", over ? "border-brand bg-brand-soft" : "border-line-strong bg-sunken", className)}
    >
      <p className="text-body text-muted">Drop contract PDFs here, or choose them from your computer. You can add several at once.</p>
      <Button disabled={disabled} onClick={() => inputRef.current?.click()}>
        Choose PDFs
      </Button>
      <input ref={inputRef} hidden type="file" multiple accept="application/pdf,.pdf" aria-label="Contract PDFs" onChange={(e) => { send(e.target.files); e.target.value = ""; }} />
      {children}
    </div>
  );
}
