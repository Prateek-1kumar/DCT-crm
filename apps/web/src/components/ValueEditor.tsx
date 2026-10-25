"use client";

import { useId, useState, type FormEvent } from "react";
import { ENUM_OPTIONS, fieldKey, formatValue, inferKind } from "@/lib/format";
import { centsToInput, parseDollars } from "@/lib/money";
import { Button, ErrorNote, cx, inputBase, inputCls } from "./ui";

/** Turn what was typed into the value to send, or an error message. */
export function parseInput(kind: ReturnType<typeof inferKind>, raw: string, invoiceable = false): { value: unknown } | { error: string } {
  const t = raw.trim();
  switch (kind) {
    case "cell":
      if (invoiceable) return { value: "invoiceable" };
    // falls through
    case "money": {
      const c = parseDollars(t);
      if (Number.isNaN(c)) return { error: "Enter a dollar amount like 1,234.56" };
      if (c === null && kind === "cell") return { error: "Enter an amount, or mark it invoiceable" };
      return { value: c };
    }
    case "int":
    case "number": {
      if (t === "") return { value: null };
      const n = Number(t);
      if (!Number.isFinite(n) || (kind === "int" && !Number.isInteger(n))) return { error: kind === "int" ? "Enter a whole number" : "Enter a number" };
      return { value: n };
    }
    case "list":
      return { value: t.split(/\n|,/).map((s) => s.trim()).filter(Boolean) };
    case "bool":
      return { value: t === "true" };
    default:
      return { value: t === "" ? null : t };
  }
}

function initial(kind: ReturnType<typeof inferKind>, value: unknown): string {
  if (kind === "money" || kind === "cell") return typeof value === "number" ? centsToInput(value) : "";
  if (kind === "list") return Array.isArray(value) ? value.join("\n") : "";
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Inline editor for one rulebook value. A note is required for every correction.
 * `onSave` gets the parsed value and the note.
 */
export function ValueEditor({
  path,
  value,
  label,
  onSave,
  onCancel,
  submitLabel = "Save correction",
}: {
  path: string;
  value: unknown;
  label: string;
  onSave: (value: unknown, note: string) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}) {
  const kind = inferKind(path, value);
  const [raw, setRaw] = useState(() => initial(kind, value));
  const [invoiceable, setInvoiceable] = useState(value === "invoiceable");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseInput(kind, raw, invoiceable);
    if ("error" in parsed) return setError(parsed.error);
    if (!note.trim()) return setError("Add a note saying why (e.g. “p.9 says $112.00”).");
    setBusy(true);
    setError(null);
    try {
      await onSave(parsed.value, note.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const input = (() => {
    const common = { id: `${id}-v`, value: raw, onChange: (e: { target: { value: string } }) => setRaw(e.target.value), className: inputCls, autoFocus: true };
    switch (kind) {
      case "money":
      case "cell":
        return (
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-40">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted">$</span>
              <input {...common} inputMode="decimal" disabled={invoiceable} className={cx(inputCls, "num pl-6")} placeholder="0.00" />
            </div>
            {kind === "cell" && (
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={invoiceable} onChange={(e) => setInvoiceable(e.target.checked)} />
                Invoiceable (billed separately)
              </label>
            )}
          </div>
        );
      case "enum":
        return (
          <select {...common} className={cx(inputBase, "w-auto")}>
            {Object.entries(ENUM_OPTIONS[fieldKey(path)] ?? {}).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        );
      case "date":
        return <input {...common} type="date" className={cx(inputBase, "w-48")} />;
      case "int":
      case "number":
        return <input {...common} type="number" step={kind === "int" ? 1 : "any"} className={cx(inputBase, "num w-32")} />;
      case "list":
        return <textarea {...common} rows={3} placeholder="One per line" />;
      case "bool":
        return (
          <select {...common} className={cx(inputBase, "w-auto")}>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        );
      default:
        return <input {...common} />;
    }
  })();

  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())} className="flex flex-col gap-3 rounded-md border border-accent/40 bg-accent-soft/40 p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-v`} className="text-xs font-medium text-muted">
          {label} <span className="font-normal">· was {formatValue(path, value)}</span>
        </label>
        {input}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-n`} className="text-xs font-medium text-muted">
          Note (required)
        </label>
        <textarea id={`${id}-n`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="Why this value? e.g. “Exhibit A p.9 prints $112.00”" />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
