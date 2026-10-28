import { type DiffEntry, ENUM_LABELS } from "@dct/shared";
import { isDeepStrictEqual } from "node:util";
import { isObj } from "./http.js";

/** Rulebook arrays whose items are matched by identity (not index). */
const COLLECTIONS = new Set(["budgetGrids", "visits", "procedures", "perPatientTotals", "invoiceables", "siteFees", "deadlines", "documents", "referencedDocuments"]);

/** Section names for top-level rulebook keys: the first part of every label (the UI groups by it). */
const SECTIONS: Record<string, string> = {
  study: "Study",
  payment: "Payment",
  overhead: "Overhead",
  budgetGrids: "Budget grid",
  invoiceables: "Invoiceable",
  siteFees: "Site fee",
  deadlines: "Deadline",
  screenFail: "Screen fail",
  holdback: "Holdback",
  overpayment: "Overpayment",
  rounding: "Rounding",
  appliesFrom: "Applies from",
  documents: "Document",
  referencedDocuments: "Referenced document",
  governingGridId: "Governing grid",
};

const pick = (x: Record<string, unknown>, keys: string[]) => keys.map((k) => x[k]).find((v) => typeof v === "string") as string | undefined;
const idOf = (x: Record<string, unknown>) => pick(x, ["id", "code", "name", "label", "kind", "description"]) ?? "";
/** Identity of every rulebook-array item a pointer passes through, e.g. ["g1", "36415"] for /budgetGrids/0/procedures/0/cells/V2. */
export function itemIds(root: unknown, tokens: string[]): string[] {
  const ids: string[] = [];
  let node = root;
  for (const t of tokens) {
    if (Array.isArray(node)) {
      node = node[Number(t)];
      if (isObj(node)) ids.push(idOf(node));
    } else node = isObj(node) && Object.hasOwn(node, t) ? node[t] : undefined;
  }
  return ids;
}
const nameOf = (x: Record<string, unknown>) => pick(x, ["name", "label", "title", "description", "kind", "code", "id"]) ?? "?";
const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const FIELD: Record<string, string> = { pct: "Percent", n: "Limit", unitCents: "Unit price", cents: "Amount" };
/** "amountWithOverheadCents" → "Amount with overhead". */
const humanize = (k: string) =>
  FIELD[k] ??
  k
    .replace(/Cents$/, "")
    .replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .replace(/^./, (c) => c.toUpperCase());
const SEP = " › ";

/** One value's label, as the diff and the web write it: "/payment/netDays/value" → "Payment › Net days". */
export function labelFor(rulebook: unknown, path: string): string {
  const tokens = path.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  const parts: string[] = [];
  let node = rulebook;
  tokens.forEach((t, i) => {
    node = Array.isArray(node) ? node[Number(t)] : isObj(node) ? node[t] : undefined;
    if (t === "value" || t === "cells") return;
    if (i === 0) parts.push(SECTIONS[t] ?? humanize(t));
    else if (/^\d+$/.test(t)) parts.push(isObj(node) ? ((typeof node.kind === "string" && ENUM_LABELS.kind?.[node.kind]) || nameOf(node)) : `#${Number(t) + 1}`);
    else parts.push(tokens[i - 1] === "cells" ? t : humanize(t));
  });
  return parts.join(SEP);
}

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
 * Labels read section first, e.g. "Budget grid › Exhibit A › Procedures › Spirometry › V2".
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
      // grid cells are keyed by visit code: keep the code as printed
      const part = k === "value" || k === "cells" ? [] : [path === "" ? (SECTIONS[k] ?? humanize(k)) : key === "cells" ? k : humanize(k)];
      const l = [...label, ...part];
      if (!(k in a)) out.push({ path: p, change: "added", before: null, after: b[k], label: l.join(SEP) });
      else if (!(k in b)) out.push({ path: p, change: "removed", before: a[k], after: null, label: l.join(SEP) });
      else walk(a[k], b[k], p, l, out, k);
    }
    return;
  }
  if (key && COLLECTIONS.has(key) && Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(isObj)) {
    const itemLabel = (x: Record<string, unknown>) => [...label, nameOf(x)];
    const olds = new Map(keyed(a).map((e) => [e.key, e]));
    for (const e of keyed(b)) {
      const old = olds.get(e.key);
      olds.delete(e.key);
      if (old) walk(old.item, e.item, `${path}/${e.i}`, itemLabel(e.item), out);
      else out.push({ path: `${path}/${e.i}`, change: "added", before: null, after: e.item, label: itemLabel(e.item).join(SEP) });
    }
    for (const e of olds.values()) out.push({ path: `${path}/${e.i}`, change: "removed", before: e.item, after: null, label: itemLabel(e.item).join(SEP) });
    return;
  }
  out.push({ path, change: "changed", before: a, after: b, label: label.join(SEP) });
}
