import type { Provenance } from "@dct/shared";

/** JSON pointer helpers (RFC 6901), used for anomaly paths and value corrections. */

export function segments(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function getAt(obj: unknown, pointer: string): unknown {
  let cur: unknown = obj;
  for (const seg of segments(pointer)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Immutable set; returns a new root. */
export function setAt<T>(obj: T, pointer: string, value: unknown): T {
  const segs = segments(pointer);
  if (segs.length === 0) return value as T;
  const clone: unknown = structuredClone(obj);
  let cur = clone as Record<string, unknown>;
  for (const seg of segs.slice(0, -1)) cur = cur[seg] as Record<string, unknown>;
  cur[segs[segs.length - 1]!] = value;
  return clone as T;
}

/** Provenance of the nearest object on the path that carries one ("/payment/netDays/value" → payment.netDays.prov). */
export function findProv(obj: unknown, pointer: string): Provenance | null {
  let cur: unknown = obj;
  let found: Provenance | null = null;
  const hasProv = (o: unknown): o is { prov: Provenance } => !!o && typeof o === "object" && "prov" in o;
  if (hasProv(cur)) found = cur.prov;
  for (const seg of segments(pointer)) {
    if (cur === null || typeof cur !== "object") break;
    cur = (cur as Record<string, unknown>)[seg];
    if (hasProv(cur)) found = cur.prov;
  }
  return found;
}
