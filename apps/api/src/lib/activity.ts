export type ActivityKind = "files" | "reading" | "decision" | "approval" | "proofread" | "parties" | "other";

interface Entry {
  by: string;
  action: string;
  detail: Record<string, unknown>;
  /** From the version the entry is about, when it is about one (or a read of one). */
  versionNumber: number | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const KIND_WORD: Record<string, string> = { sponsor: "sponsor", cro: "CRO", site: "site" };
const SLOT_WORD: Record<string, string> = { sponsor: "sponsor", payer: "CRO", site: "site" };

/** What a study.parties entry changed, e.g. `set the sponsor to "Acme" and cleared the site`. */
function partiesChange(set: unknown) {
  const parts = Object.entries(set && typeof set === "object" ? (set as Record<string, unknown>) : {}).map(([slot, name]) => {
    const word = SLOT_WORD[slot] ?? "party";
    const to = str(name);
    return to ? `set the ${word} to "${to}"` : `cleared the ${word}`;
  });
  if (!parts.length) return "changed the parties";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** An accountant's sentence for one audit entry, and the group it belongs to; never the action code or raw detail. */
export function describeAudit({ by, action, detail, versionNumber }: Entry): { summary: string; kind: ActivityKind } {
  const n = versionNumber ?? (typeof detail.number === "number" ? detail.number : null);
  const version = n === null ? "this contract" : `version ${n}`;
  const file = str(detail.name);
  switch (action) {
    case "read.started":
      return { kind: "reading", summary: `${by} started reading ${version}` };
    // fillStudy is saved in the same transaction as a finished read, so it is the log's only sign that one ended
    case "study.fill":
      return { kind: "reading", summary: `${by} finished reading the contract and filled in its details` };
    case "version.answered": {
      const label = str(detail.label);
      return { kind: "decision", summary: `${by} answered a decision on ${version}${label ? ` with "${clip(label)}"` : ""}` };
    }
    case "version.approved":
      return { kind: "approval", summary: `${by} approved ${version} and made it live` };
    case "version.superseded":
      return { kind: "approval", summary: `${by} approved a newer version, so ${version} is no longer live` };
    case "version.proofread": {
      const count = Array.isArray(detail.items) ? detail.items.length : 0;
      return { kind: "proofread", summary: `${by} proofread ${count ? plural(count, "item") : "items"} on ${version}` };
    }
    case "version.unproofread":
      return { kind: "proofread", summary: `${by} took their proofreading mark off an item on ${version}` };
    case "version.flagged":
      return { kind: "proofread", summary: `${by} flagged something that looks wrong on ${version}` };
    case "version.unflagged":
      return { kind: "proofread", summary: `${by} took their flag off an item on ${version}` };
    case "document.upload":
      return { kind: "files", summary: `${by} uploaded ${file ? `"${clip(file)}"` : "a file"}` };
    case "study.document.add":
      return { kind: "files", summary: `${by} added ${file ? `"${clip(file)}"` : "a file"} to this contract` };
    case "study.document.remove":
      return { kind: "files", summary: `${by} removed ${file ? `"${clip(file)}"` : "a file"} from this contract` };
    case "study.create":
      return { kind: "other", summary: `${by} added a new contract` };
    case "party.create": {
      const name = str(detail.name);
      return { kind: "parties", summary: `${by} added the ${KIND_WORD[String(detail.kind)] ?? "party"}${name ? ` "${clip(name)}"` : ""}` };
    }
    case "party.alias": {
      const alias = str(detail.alias);
      const name = str(detail.name);
      return { kind: "parties", summary: `${by} added ${alias ? `"${clip(alias)}"` : "another name"} as a name for ${name ? `"${clip(name)}"` : "a party"}` };
    }
    case "party.rename": {
      const [from, to] = [str(detail.from), str(detail.to)];
      return { kind: "parties", summary: from && to ? `${by} renamed "${clip(from)}" to "${clip(to)}"` : `${by} renamed a party` };
    }
    case "party.merge": {
      const [from, into] = [str(detail.from), str(detail.into)];
      const moved = typeof detail.studies === "number" ? ` (${plural(detail.studies, "contract")} moved)` : "";
      return { kind: "parties", summary: from && into ? `${by} merged "${clip(from)}" into "${clip(into)}"${moved}` : `${by} merged two parties${moved}` };
    }
    case "study.parties":
      return { kind: "parties", summary: `${by} ${partiesChange(detail.set)} on this contract` };
    default:
      return { kind: "other", summary: "Something changed" };
  }
}
