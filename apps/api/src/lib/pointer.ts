import { HttpError, isObj } from "./http.js";

/** RFC 6901 JSON pointer → tokens. */
export function parsePointer(p: string): string[] {
  if (p === "") return [];
  if (!p.startsWith("/")) throw new HttpError(400, `Invalid JSON pointer "${p}": must start with "/"`);
  const tokens = p.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (tokens.includes("__proto__")) throw new HttpError(400, `Invalid JSON pointer "${p}"`);
  return tokens;
}

const index = (t: string) => {
  if (!/^(0|[1-9]\d*)$/.test(t)) throw new HttpError(400, `"${t}" is not an array index`);
  return Number(t);
};

function child(node: unknown, t: string): unknown {
  if (Array.isArray(node)) return node[index(t)];
  if (isObj(node)) return Object.hasOwn(node, t) ? node[t] : undefined;
  return undefined;
}

export function getAt(root: unknown, tokens: string[]): unknown {
  let node = root;
  for (const t of tokens) node = child(node, t);
  return node;
}

/** Replace (or add) the value at `tokens`. Parents must exist. */
export function setAt(root: unknown, tokens: string[], value: unknown): void {
  const last = tokens.at(-1);
  if (last === undefined) throw new HttpError(400, "Cannot replace the whole rulebook");
  const parent = getAt(root, tokens.slice(0, -1));
  if (Array.isArray(parent)) {
    const i = last === "-" ? parent.length : index(last);
    if (i > parent.length) throw new HttpError(400, `Index ${i} is out of range`);
    parent[i] = value;
  } else if (isObj(parent)) {
    parent[last] = value;
  } else {
    throw new HttpError(400, `Path /${tokens.join("/")} does not exist`);
  }
}

/** Set `prov.method = "manual"` on the nearest node (the target or an ancestor) that carries a `prov`. */
export function markManual(root: unknown, tokens: string[]): void {
  for (let n = tokens.length; n > 0; n--) {
    const node = getAt(root, tokens.slice(0, n));
    if (isObj(node) && isObj(node.prov)) {
      node.prov.method = "manual";
      return;
    }
  }
}
