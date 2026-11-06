import { Rulebook, Term, type Patch } from "./rulebook";

type Grid = Rulebook["grids"][number];

// "length" is own on arrays but not a place in the grid
const holds = (node: unknown, key: string): node is Record<string, unknown> =>
  typeof node === "object" && node !== null && Object.hasOwn(node, key) && !(Array.isArray(node) && key === "length");

function setPath(grid: Grid, path: string, value: unknown) {
  const keys = path.split(".");
  const last = keys.pop()!;
  const missing = () => new Error(`Grid '${grid.id}' has no place called '${path}', so that value can't be changed.`);
  let node: unknown = grid;
  for (const key of keys) {
    if (!holds(node, key)) throw missing();
    node = node[key];
  }
  if (!holds(node, last)) throw missing();
  node[last] = value;
}

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues.map((i) => `${i.path.join(".") || "the term"}: ${i.message}`).join("; ");

function patchTerm(rulebook: Rulebook, { id, set }: Patch) {
  const term = rulebook.terms.find((t) => t.id === id);
  if (!term) {
    // a created term has no proof yet: a patch from an agent can't carry one
    const created = Term.safeParse({ evidence: "none", ...set, id });
    if (!created.success) throw new Error(`Term '${id}' doesn't exist yet, so the change has to give all of its details (${issues(created.error)}).`);
    rulebook.terms.push(created.data);
    return;
  }
  if (Object.hasOwn(set, "id")) throw new Error(`Term '${id}' already exists, so it can't be added again.`);
  for (const key of Object.keys(set)) {
    if (!Object.hasOwn(term, key)) throw new Error(`A term has no field called '${key}', so term '${id}' can't be changed that way.`);
  }
  Object.assign(term, set);
}

const CITE = "cellIds.";

function patchGrid(rulebook: Rulebook, { id, set }: Patch) {
  const grid = rulebook.grids.find((g) => g.id === id);
  if (!grid) throw new Error(`There is no grid '${id}' to change.`);
  for (const [path, value] of Object.entries(set)) {
    if (!path.startsWith(CITE)) setPath(grid, path, value);
    // keyed by the cited value's own dotted path, so the rest of the key is one key, not a path to walk
    else if (value === null) delete grid.cellIds?.[path.slice(CITE.length)];
    else (grid.cellIds ??= {})[path.slice(CITE.length)] = value as string;
  }
}

/** Returns a new rulebook with the patches applied in order; the input is never changed. Throws in plain English if a patch doesn't fit or the result isn't a valid rulebook. */
export function applyPatches(rulebook: Rulebook, patches: Patch[]): Rulebook {
  const next = structuredClone(rulebook);
  // a rulebook stored before this field existed has no place for a patch to set
  for (const grid of next.grids) grid.acceptedAsPrinted ??= false;
  for (const patch of patches) (patch.target === "term" ? patchTerm : patchGrid)(next, patch);
  const result = Rulebook.safeParse(next);
  if (!result.success) throw new Error(`That change would leave the rulebook invalid: ${issues(result.error)}.`);
  return result.data;
}

const CELL = /^rows\.(\d+)\.cells\.(\d+)$/;

/**
 * Patches that add every grid cell the given patches set to its grid's cellsReadTwice. That list means the cell no longer
 * rests on the model's word alone, whoever settled it: a second read, or a person's answer.
 */
export function cellProofPatches(rulebook: Rulebook, patches: Patch[]): Patch[] {
  const cells = new Map<string, [number, number][]>();
  for (const p of patches) {
    if (p.target !== "grid") continue;
    for (const key of Object.keys(p.set)) {
      const m = CELL.exec(key);
      if (!m) continue;
      const known = cells.get(p.id) ?? rulebook.grids.find((g) => g.id === p.id)?.cellsReadTwice ?? [];
      const cell: [number, number] = [Number(m[1]), Number(m[2])];
      cells.set(p.id, known.some(([r, c]) => r === cell[0] && c === cell[1]) ? known : [...known, cell]);
    }
  }
  return [...cells].map(([id, set]): Patch => ({ target: "grid", id, set: { cellsReadTwice: set } }));
}
