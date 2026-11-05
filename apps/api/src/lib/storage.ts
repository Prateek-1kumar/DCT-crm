import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Where a stored PDF lives: one file per content, named by its sha256. */
export const pdfPath = (hash: string) => path.join(config.uploadDir, `${hash}.pdf`);

/** Writes the PDF under its hash; written to a temporary name first, so a crash never leaves half a file under the real one. */
export async function savePdf(data: Buffer): Promise<string> {
  const hash = sha256(data);
  await mkdir(config.uploadDir, { recursive: true });
  const tmp = `${pdfPath(hash)}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, pdfPath(hash));
  return hash;
}
