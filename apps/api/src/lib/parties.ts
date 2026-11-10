import { eq } from "drizzle-orm";
import type { Study } from "@dct/shared";
import type { Tx } from "../db/index.js";
import { parties, studies } from "../db/schema.js";
import { audit } from "./audit.js";

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const READER = "Contract reader";

async function linkParty(tx: Tx, kind: "sponsor" | "cro" | "site", name: string | null) {
  if (!name || !norm(name)) return null;
  const known = (await tx.select().from(parties).where(eq(parties.kind, kind))).find((p) => [p.name, ...p.aliases].some((n) => norm(n) === norm(name)));
  if (known) return known.id;
  const [created] = await tx.insert(parties).values({ kind, name: name.trim(), createdBy: READER }).returning();
  await audit(tx, { by: READER, action: "party.create", entity: "party", entityId: created!.id, detail: { kind, name: created!.name } });
  return created!.id;
}

/** Fills the study from what the contract says about itself; call it in the transaction that saves the read. */
export async function fillStudy(tx: Tx, studyId: string, { protocol, sponsor, payer, siteEntity }: Study) {
  const fields = { protocol, sponsorId: await linkParty(tx, "sponsor", sponsor), payerId: await linkParty(tx, "cro", payer), siteId: await linkParty(tx, "site", siteEntity) };
  await tx.update(studies).set(fields).where(eq(studies.id, studyId));
  await audit(tx, { by: READER, action: "study.fill", entity: "study", entityId: studyId, detail: fields });
}
