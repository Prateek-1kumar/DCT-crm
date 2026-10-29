/**
 * JSON pointers (RFC 6901) for the review rules, read as the API reads them: a pointer that doesn't fit the shape is an
 * error, never a value. Plain errors here; the API's routes word their own (apps/api/src/lib/pointer.ts).
 */

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function parsePointer(p: string): string[] {
  if (p === "") return [];
  if (!p.startsWith("/")) throw new Error(`Invalid JSON pointer "${p}"`);
  const tokens = p.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (tokens.includes("__proto__")) throw new Error(`Invalid JSON pointer "${p}"`);
  return tokens;
}

const pointerOf = (tokens: string[]) => tokens.map((t) => `/${t.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");

const index = (t: string) => {
  if (!/^(0|[1-9]\d*)$/.test(t)) throw new Error(`"${t}" is not an array index`);
  return Number(t);
};

function getAt(root: unknown, tokens: string[]): unknown {
  let node = root;
  for (const t of tokens) node = Array.isArray(node) ? node[index(t)] : isObj(node) && Object.hasOwn(node, t) ? node[t] : undefined;
  return node;
}

/** Replace (or add) the value at `tokens`, in place. Parents must exist. */
export function setAt(root: unknown, tokens: string[], value: unknown): void {
  const last = tokens.at(-1);
  if (last === undefined) throw new Error("Cannot replace the whole rulebook");
  const parent = getAt(root, tokens.slice(0, -1));
  if (Array.isArray(parent)) {
    const i = last === "-" ? parent.length : index(last);
    if (i > parent.length) throw new Error(`Index ${i} is out of range`);
    parent[i] = value;
  } else if (isObj(parent)) parent[last] = value;
  else throw new Error(`Path ${pointerOf(tokens)} does not exist`);
}

/** Value at a JSON pointer; undefined when the pointer doesn't fit the shape. */
export const at = (root: unknown, path: string): unknown => {
  try {
    return getAt(root, parsePointer(path));
  } catch {
    return undefined;
  }
};
