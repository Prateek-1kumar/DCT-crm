"use client";

import type { BudgetGrid, ContractAnomaly } from "@dct/shared";
import { useState } from "react";
import { ANOMALY_LABEL, formatDateTime, formatValue } from "@/lib/format";
import { getAt } from "@/lib/pointer";
import { groupBySeverity, settleProgress } from "@/lib/review";
import { GridCompare } from "./GridCompare";
import { useRulebook } from "./review-context";
import { Badge, Button, Dialog, ErrorNote, ProgressBar, cx, inputCls, type Tone } from "./ui";
import { ValueEditor } from "./ValueEditor";

type ResolveKind = "fixed" | "chosen" | "accepted_with_note";
export type AnomalyActions = {
  resolve: (a: ContractAnomaly, kind: ResolveKind, note: string) => Promise<void>;
  chooseGrid: (gridId: string, note: string) => Promise<void>;
};

const SEV: Record<ContractAnomaly["severity"], { tone: Tone; label: string }> = {
  blocker: { tone: "danger", label: "Blockers" },
  warning: { tone: "warn", label: "Warnings" },
  info: { tone: "info", label: "Info" },
};
const RES_LABEL: Record<ResolveKind, string> = { fixed: "Fixed", chosen: "Chosen", accepted_with_note: "Accepted" };

export function AnomalyPanel({ anomalies, actions }: { anomalies: ContractAnomaly[]; actions: AnomalyActions }) {
  const { settled, total } = settleProgress(anomalies);
  const [showSettled, setShowSettled] = useState(true);
  if (!total)
    return (
      <section aria-label="Anomalies" className="rounded-card border border-ok/30 bg-ok-soft px-4 py-3 text-sm text-ok">
        ✓ No anomalies. The contract checks found nothing to settle.
      </section>
    );
  return (
    <section aria-labelledby="anom-h" className="rounded-card border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 id="anom-h" className="font-semibold">
          Anomalies
        </h2>
        <span className="text-sm" aria-live="polite">
          <strong className="num">{settled}</strong> of <span className="num">{total}</span> settled
        </span>
        <div className="w-40">
          <ProgressBar value={(settled / total) * 100} label="Anomalies settled" />
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} /> Show settled
        </label>
      </header>
      <div className="flex flex-col gap-4 p-4">
        {groupBySeverity(anomalies).map((g) => {
          const items = g.items.filter((a) => showSettled || !a.resolution);
          if (!items.length) return null;
          return (
            <div key={g.severity}>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
                <Badge tone={SEV[g.severity].tone}>{SEV[g.severity].label}</Badge>
                {g.items.filter((a) => !a.resolution).length} open
              </h3>
              <ul className="flex flex-col gap-2">
                {items.map((a) => (
                  <AnomalyCard key={a.id} a={a} actions={actions} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A path we can edit as a single value (not an object/array of objects). */
function isLeaf(v: unknown) {
  return v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => typeof x !== "object"));
}

function AnomalyCard({ a, actions }: { a: ContractAnomaly; actions: AnomalyActions }) {
  const { rulebook, show, editable, save } = useRulebook();
  const [mode, setMode] = useState<null | "fix" | "accept" | "choose">(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = a.path ? getAt(rulebook, a.path) : undefined;
  const canFix = !!a.path && current !== undefined && isLeaf(current);
  const readings = a.code === "AI_DISAGREEMENT" && "claude" in a.detail && "openai" in a.detail ? (["claude", "openai"] as const) : null;
  const conflictGrids = a.code === "GRID_CONFLICT" ? gridsFor(a, rulebook.budgetGrids) : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode(null);
      setNote("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={cx("rounded-md border px-3 py-2.5", a.resolution ? "border-line bg-sunken/60" : "border-line-strong bg-surface")}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className={cx("text-sm font-medium", a.resolution && "text-muted")}>
            {a.resolution && <span className="text-ok">✓ </span>}
            {ANOMALY_LABEL[a.code]}
          </p>
          <p className="text-sm text-muted">{a.message}</p>
          <Detail a={a} />
          <div className="mt-1 flex flex-wrap gap-2">
            {a.refs.map((r, i) => (
              <button key={i} type="button" onClick={() => show(a.path ?? "", { source: r, confidence: 1, method: "ai", crossCheck: "not_checked" }, ANOMALY_LABEL[a.code])} className="text-xs text-accent hover:underline">
                Show p.{r.page}
                {r.location ? ` · ${r.location}` : ""} ↗
              </button>
            ))}
          </div>
        </div>
        {!a.resolution && editable && mode === null && (
          <div className="flex flex-wrap gap-1.5">
            {canFix && (
              <Button size="sm" onClick={() => setMode("fix")}>
                Fix value
              </Button>
            )}
            {(readings || conflictGrids) && (
              <Button size="sm" variant="primary" onClick={() => setMode("choose")}>
                {conflictGrids ? "Compare & choose grid" : "Choose reading"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setMode("accept")}>
              Accept with note
            </Button>
          </div>
        )}
      </div>

      {a.resolution && (
        <p className="mt-1.5 text-xs text-muted">
          <Badge tone="ok">{RES_LABEL[a.resolution.kind]}</Badge> by {a.resolution.by} · {formatDateTime(a.resolution.at)} — “{a.resolution.note}”
        </p>
      )}

      {mode === "fix" && a.path && (
        <div className="mt-2">
          <ValueEditor
            path={a.path}
            value={current}
            label="Correct value"
            submitLabel="Save and mark fixed"
            onCancel={() => setMode(null)}
            onSave={async (v, n) => {
              await save(a.path!, v, n);
              await actions.resolve(a, "fixed", n);
              setMode(null);
            }}
          />
        </div>
      )}

      {mode === "choose" && readings && a.path && (
        <form
          className="mt-2 flex flex-col gap-2 rounded-md border border-accent/40 bg-accent-soft/40 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const pick = new FormData(e.currentTarget).get("reading") as (typeof readings)[number] | null;
            if (!pick || !note.trim()) return setError(new Error("Pick a reading and add a note."));
            const value = a.detail[pick];
            void run(async () => {
              if (JSON.stringify(value) !== JSON.stringify(current)) await save(a.path!, value, note.trim());
              await actions.resolve(a, "chosen", note.trim());
            });
          }}
        >
          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-1 text-xs font-medium text-muted">Which reading matches the contract page?</legend>
            {readings.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm has-checked:border-accent has-checked:bg-accent-soft">
                <input type="radio" name="reading" value={k} />
                <span className="text-muted">{k === "claude" ? "Claude (primary)" : "OpenAI (second read)"}</span>
                <span className="num font-semibold">{formatValue(a.path!, a.detail[k])}</span>
                {JSON.stringify(a.detail[k]) === JSON.stringify(current) && <Badge>current</Badge>}
              </label>
            ))}
          </fieldset>
          <NoteField note={note} setNote={setNote} />
          <ErrorNote error={error} />
          <FormButtons busy={busy} label="Use this reading" onCancel={() => setMode(null)} />
        </form>
      )}

      {conflictGrids && (
        <Dialog open={mode === "choose"} onClose={() => setMode(null)} title="Choose the governing budget grid" wide>
          <GridCompare grids={conflictGrids} busy={busy} error={error} onChoose={(gridId, n) => void run(() => actions.chooseGrid(gridId, n))} />
        </Dialog>
      )}

      {mode === "accept" && (
        <form
          className="mt-2 flex flex-col gap-2 rounded-md border border-line bg-sunken p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return setError(new Error("A note is required to accept."));
            void run(() => actions.resolve(a, "accepted_with_note", note.trim()));
          }}
        >
          <NoteField note={note} setNote={setNote} placeholder="Why is this OK as-is? e.g. “Confirmed with sponsor by email 3 Oct.”" />
          <ErrorNote error={error} />
          <FormButtons busy={busy} label="Accept" onCancel={() => setMode(null)} />
        </form>
      )}
    </li>
  );
}

function gridsFor(a: ContractAnomaly, grids: BudgetGrid[]): [BudgetGrid, BudgetGrid] | null {
  const ids = Array.isArray(a.detail.gridIds) ? (a.detail.gridIds as string[]) : grids.map((g) => g.id);
  const found = ids.map((id) => grids.find((g) => g.id === id)).filter(Boolean) as BudgetGrid[];
  return found.length >= 2 ? [found[0]!, found[1]!] : null;
}

function Detail({ a }: { a: ContractAnomaly }) {
  const entries = Object.entries(a.detail).filter(([k]) => !["gridIds", "claude", "openai"].includes(k));
  if (!entries.length) return null;
  const fmt = (k: string, v: unknown): string => {
    if (v && typeof v === "object" && !Array.isArray(v))
      return Object.entries(v as Record<string, unknown>)
        .map(([kk, vv]) => `${kk}: ${formatValue("", vv)}`)
        .join(", ");
    if (typeof v === "number" && /expected|actual/.test(k) && a.path) return formatValue(a.path, v);
    if (k === "confidence" && typeof v === "number") return `${Math.round(v * 100)}%`;
    return formatValue("", v);
  };
  return (
    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-1">
          <dt className="text-muted capitalize">{k}:</dt>
          <dd className="num">{fmt(k, v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function NoteField({ note, setNote, placeholder = "Note (required)" }: { note: string; setNote: (s: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
      Note (required)
      <textarea rows={2} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder={placeholder} />
    </label>
  );
}

function FormButtons({ busy, label, onCancel }: { busy: boolean; label: string; onCancel: () => void }) {
  return (
    <div className="flex gap-2">
      <Button type="submit" size="sm" variant="primary" disabled={busy}>
        {busy ? "Saving…" : label}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
