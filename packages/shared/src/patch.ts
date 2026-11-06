import { Accounted, Rulebook, Term, type Patch } from "./rulebook";

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

const SOURCE_CELL = "source.cell";
const SOURCE_CAP_CELL = "source.capCell";

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
  if ("source" in set && (typeof set.source !== "object" || set.source === null || Array.isArray(set.source))) {
    throw new Error("That answer would leave the term without a page to point to, so it wasn't applied.");
  }
  const { [SOURCE_CELL]: cell, [SOURCE_CAP_CELL]: capCell, ...fields } = set;
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(term, key)) throw new Error(`A term has no field called '${key}', so term '${id}' can't be changed that way.`);
  }
  const cites = { cell: SOURCE_CELL in set ? cell : term.source.cell, capCell: SOURCE_CAP_CELL in set ? capCell : term.source.capCell };
  Object.assign(term, fields);
  // a new source keeps the cells its amounts cite: only "source.cell" and "source.capCell" change those, and null clears one
  const { cell: _cell, capCell: _capCell, ...source } = term.source;
  term.source = { ...source, ...Object.fromEntries(Object.entries(cites).filter(([, v]) => v != null)) };
}

const CITE = "cellIds.";

function patchGrid(rulebook: Rulebook, { id, set }: Patch) {
  const grid = rulebook.grids.find((g) => g.id === id);
  if (!grid) throw new Error(`There is no grid '${id}' to change.`);
  for (const [path, value] of Object.entries(set)) {
    if (!path.startsWith(CITE)) setPath(grid, path, value);
    // keyed by the cited value's own dotted path, so the rest of the key is one key, not a path to walk
    else (grid.cellIds ??= {})[path.slice(CITE.length)] = value as string | null;
  }
}

/** Returns a new rulebook with the patches applied in order; the input is never changed. Throws in plain English if a patch doesn't fit or the result isn't a valid rulebook. */
export function applyPatches(rulebook: Rulebook, patches: Patch[]): Rulebook {
  const next = structuredClone(rulebook);
  // a rulebook stored before this field existed has no place for a patch to set
  for (const grid of next.grids) grid.acceptedAsPrinted ??= false;
  for (const patch of patches) {
    if (patch.target !== "accounted") (patch.target === "term" ? patchTerm : patchGrid)(next, patch);
    else {
      const entry = Accounted.safeParse(patch.set);
      if (!entry.success) throw new Error(`That answer can't set the amount aside (${issues(entry.error)}).`);
      next.accounted.push(entry.data);
    }
  }
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

export const valueAt = (node: unknown, path: string) => path.split(".").reduce<unknown>((n, key) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[key] : undefined), node);
const capAmount = (cap: unknown) => (typeof cap === "object" && cap !== null && "kind" in cap && cap.kind === "amount" && "value" in cap ? cap.value : null);

/**
 * Patches that drop the citation of every scanned amount the given patches change, unless they cite it again themselves:
 * the cited cell prints the old amount, so the new one rests on whoever changed it, never on that cell.
 */
export function citationPatches(rulebook: Rulebook, patches: Patch[]): Patch[] {
  const dropped: Patch[] = [];
  for (const t of rulebook.terms) {
    const sets = patches.filter((p) => p.target === "term" && p.id === t.id).map((p) => p.set);
    const amount = t.source.cell !== undefined && !sets.some((set) => SOURCE_CELL in set) && sets.some((set) => "amountCents" in set && set.amountCents !== t.amountCents);
    const cap = t.source.capCell !== undefined && !sets.some((set) => SOURCE_CAP_CELL in set) && sets.some((set) => "cap" in set && capAmount(set.cap) !== capAmount(t.cap));
    if (amount || cap) dropped.push({ target: "term", id: t.id, set: { ...(amount && { [SOURCE_CELL]: null }), ...(cap && { [SOURCE_CAP_CELL]: null }) } });
  }
  for (const g of rulebook.grids) {
    const sets = patches.filter((p) => p.target === "grid" && p.id === g.id).flatMap((p) => Object.entries(p.set));
    for (const [cited, id] of Object.entries(g.cellIds ?? {})) {
      if (id === null || sets.some(([path]) => path === `${CITE}${cited}`)) continue;
      const before = valueAt(g, cited);
      // a patch may set the amount itself ("total.2") or a line that holds it ("total")
      const after = (path: string, value: unknown) => (path === cited ? value : cited.startsWith(`${path}.`) ? valueAt(value, cited.slice(path.length + 1)) : before);
      if (sets.some(([path, value]) => !path.startsWith(CITE) && after(path, value) !== before)) dropped.push({ target: "grid", id: g.id, set: { [`${CITE}${cited}`]: null } });
    }
  }
  return dropped;
}

/** The page a scanned cell or line id is on ("p7.t1.r5.c3" is on p.7); NaN for anything else. */
export const pageOfCell = (id: string) => Number(/^p(\d+)\./.exec(id)?.[1]);

export const CORRECTED = "corrected by a person";
export const CORRECTED_BY_SECOND_READ = "corrected by a second read";
/** An amount only a page's second read found, that a person said isn't a separate amount. */
export const SET_ASIDE = "set aside by a person";
/** An amount only a page's second read found, that a person put into the grid cell the first read left blank. */
export const ADDED_TO_GRID = "added to the grid by a person";
/** The reasons only the harness gives, never the compile agent. */
export const KEPT_REASONS = [CORRECTED, CORRECTED_BY_SECOND_READ, SET_ASIDE, ADDED_TO_GRID];

/**
 * The cells the given citationPatches drop, set aside: each still prints the amount an answer or a second read replaced,
 * which would otherwise count as printed money nobody captured and block approval for good.
 */
export function correctedCells(rulebook: Rulebook, dropped: Patch[], reason = CORRECTED): Accounted[] {
  return dropped.flatMap(({ target, id, set }) =>
    Object.keys(set).flatMap((key) => {
      const term = target === "term" ? rulebook.terms.find((t) => t.id === id) : undefined;
      const grid = target === "grid" ? rulebook.grids.find((g) => g.id === id) : undefined;
      const cell = term ? { [SOURCE_CELL]: term.source.cell, [SOURCE_CAP_CELL]: term.source.capCell }[key] : key.startsWith(CITE) ? grid?.cellIds?.[key.slice(CITE.length)] : undefined;
      const doc = term?.source.doc ?? grid?.doc;
      const page = pageOfCell(cell ?? "");
      return cell && doc && page > 0 ? [{ doc, page, cell, reason }] : [];
    }),
  );
}
