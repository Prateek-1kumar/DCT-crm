import type { DiffEntry } from "@dct/shared";
import { isDeepStrictEqual } from "node:util";
import { isObj } from "./http.js";

/** Rulebook arrays whose items are matched by identity (not index), and their human label. */
const COLLECTIONS: Record<string, string> = {
  budgetGrids: "Grid",
  visits: "visit",
  procedures: "procedure",
  perPatientTotals: "per-patient total",
  invoiceables: "Invoiceable",
  siteFees: "Site fee",
  deadlines: "Deadline",
  documents: "Document",
  referencedDocuments: "Referenced document",
};

const pick = (x: Record<string, unknown>, keys: string[]) => keys.map((k) => x[k]).find((v) => typeof v === "string") as string | undefined;
const idOf = (x: Record<string, unknown>) => pick(x, ["id", "code", "name", "label", "kind", "description"]) ?? "";
const nameOf = (x: Record<string, unknown>) => pick(x, ["name", "label", "title", "description", "kind", "code", "id"]) ?? "?";
const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");

/** Index items by identity; repeated identities get an occurrence suffix. */
function keyed(items: Record<string, unknown>[]) {
  const seen = new Map<string, number>();
  return items.map((item, i) => {
    const id = idOf(item);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return { key: `${id}#${n}`, item, i };
  });
}

/**
 * Structural diff of two rulebooks (before → after). `prov` subtrees are ignored (confidence and
 * source changes are noise for an amendment review); `{value, prov}` wrappers collapse to the value.
 */
export function diffRulebooks(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(before, after, "", [], out);
  return out;
}

function walk(a: unknown, b: unknown, path: string, label: string[], out: DiffEntry[], key?: string): void {
  if (isDeepStrictEqual(a, b)) return;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k === "prov") continue;
      const p = `${path}/${esc(k)}`;
      const l = k === "value" ? label : [...label, k];
      if (!(k in a)) out.push({ path: p, change: "added", before: null, after: b[k], label: l.join(" ") });
      else if (!(k in b)) out.push({ path: p, change: "removed", before: a[k], after: null, label: l.join(" ") });
      else walk(a[k], b[k], p, l, out, k);
    }
    return;
  }
  const noun = key && COLLECTIONS[key];
  if (noun && Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(isObj)) {
    const base = label.slice(0, -1);
    const itemLabel = (x: Record<string, unknown>) => [...base, `${noun} '${nameOf(x)}'`];
    const olds = new Map(keyed(a).map((e) => [e.key, e]));
    for (const e of keyed(b)) {
      const old = olds.get(e.key);
      olds.delete(e.key);
      if (old) walk(old.item, e.item, `${path}/${e.i}`, itemLabel(e.item), out);
      else out.push({ path: `${path}/${e.i}`, change: "added", before: null, after: e.item, label: itemLabel(e.item).join(" ") });
    }
    for (const e of olds.values()) out.push({ path: `${path}/${e.i}`, change: "removed", before: e.item, after: null, label: itemLabel(e.item).join(" ") });
    return;
  }
  out.push({ path, change: "changed", before: a, after: b, label: label.join(" ") });
}
