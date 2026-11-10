"use client";

import { MotionConfig, motion } from "framer-motion";
import { Upload } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Button, cx } from "../ui";

/** The API's own per-file limit (maxUploadBytes), so a file it would refuse is turned away here with a clear sentence. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** Splits what was dropped or chosen into the PDFs to send and one plain sentence for every file left out. */
export function sortFiles(files: File[], have: { name: string; size: number }[] = []): { pdfs: File[]; skipped: string[] } {
  const pdfs: File[] = [];
  const skipped: string[] = [];
  const seen = new Set(have.map((f) => `${f.name}:${f.size}`));
  for (const f of files) {
    if (!isPdf(f)) skipped.push(`${f.name} isn't a PDF, so it was left out.`);
    else if (f.size > MAX_FILE_BYTES) skipped.push(`${f.name} is over 50 MB. Split it into parts and add each one.`);
    else if (seen.has(`${f.name}:${f.size}`)) skipped.push(`${f.name} is already in your list.`);
    else {
      seen.add(`${f.name}:${f.size}`);
      pdfs.push(f);
    }
  }
  return { pdfs, skipped };
}

// One element, not hundreds of tiles: a faint grid that fades out towards the edges.
const FADE = "radial-gradient(ellipse at center, black 15%, transparent 72%)";
const GRID = {
  backgroundImage: "linear-gradient(to right, var(--color-line) 1px, transparent 1px), linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)",
  backgroundSize: "28px 28px",
  maskImage: FADE,
  WebkitMaskImage: FADE,
};

const TILE = { rest: { y: 0, scale: 1 }, hover: { y: -6, scale: 1 }, drag: { y: -12, scale: 1.08 } };
const GHOST = { rest: { opacity: 0, x: 0, y: 0 }, hover: { opacity: 1, x: 12, y: 12 }, drag: { opacity: 1, x: 16, y: 16 } };
const SPRING = { type: "spring", stiffness: 300, damping: 20 } as const;

/**
 * Where PDFs are dropped or chosen. It only hands the files on (`onFiles`); what to do with them is the page's call.
 * `compact` is the slim row used once files are in.
 */
export function FileDrop({ onFiles, disabled, compact, children }: { onFiles: (files: File[]) => void; disabled?: boolean; compact?: boolean; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  // dragenter and dragleave fire for every child the pointer crosses, so they are counted: a plain on/off flickers.
  const [depth, setDepth] = useState(0);
  const over = depth > 0 && !disabled;

  const send = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (files.length && !disabled) onFiles(files);
  };
  const open = () => {
    if (!disabled) input.current?.click();
  };
  const carriesFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const drag = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setDepth((d) => d + 1);
    },
    onDragOver: (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    },
    onDragLeave: (e: DragEvent) => {
      if (carriesFiles(e)) setDepth((d) => Math.max(0, d - 1));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDepth(0);
      send(e.dataTransfer.files);
    },
  };

  const picker = (
    <input
      ref={input}
      hidden
      type="file"
      multiple
      accept="application/pdf,.pdf"
      aria-label="Contract PDFs"
      onChange={(e) => {
        send(e.target.files);
        e.target.value = "";
      }}
    />
  );
  const choose = (
    <Button
      variant={compact ? "secondary" : "primary"}
      size={compact ? "sm" : "lg"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
    >
      Choose PDFs
    </Button>
  );

  if (compact) {
    return (
      <div
        {...drag}
        onClick={open}
        className={cx("flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-3 rounded-tile border border-dashed px-5 py-4 transition-colors", over ? "border-brand bg-brand-soft" : "border-line-strong bg-surface", !disabled && "cursor-pointer hover:border-brand/60")}
      >
        <Upload aria-hidden className="size-5 text-accent" strokeWidth={1.75} />
        <p className="text-body text-ink-2">{over ? "Drop to add them" : "Drop more PDFs here"}</p>
        {choose}
        {children}
        {picker}
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        {...drag}
        onClick={open}
        initial="rest"
        animate={over ? "drag" : "rest"}
        whileHover={disabled ? undefined : "hover"}
        className={cx("relative w-full overflow-hidden rounded-card border border-dashed text-center transition-colors", over ? "border-brand bg-brand-soft" : "border-line-strong bg-surface", !disabled && "cursor-pointer hover:border-brand/60")}
      >
        <div aria-hidden style={GRID} className="pointer-events-none absolute inset-0" />
        <div className="relative flex flex-col items-center gap-3 px-8 py-16">
          <div className="relative mb-3 h-24 w-28">
            <motion.div aria-hidden variants={GHOST} transition={SPRING} className="absolute inset-0 rounded-tile border border-dashed border-brand/60" />
            <motion.div variants={TILE} transition={SPRING} className="relative grid size-full place-items-center rounded-tile bg-surface shadow-card">
              <Upload aria-hidden className="size-7 text-accent" strokeWidth={1.75} />
            </motion.div>
          </div>
          <h2 className="text-title font-semibold tracking-tight">{over ? "Drop them to add them" : "Drop your contract PDFs here"}</h2>
          <p className="max-w-md text-balance text-body text-muted">The signed contract and any amendments. You can add several at once.</p>
          <div className="mt-2">{choose}</div>
          <p className="text-small text-faint">PDF files only · up to 50 MB each</p>
          {children}
        </div>
        {picker}
      </motion.div>
    </MotionConfig>
  );
}
