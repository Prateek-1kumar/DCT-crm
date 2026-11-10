import { fileScanStore } from "@dct/harness";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Where a stored PDF lives: one file per content, named by its sha256. */
export const pdfPath = (hash: string) => path.join(config.uploadDir, `${hash}.pdf`);

/** Written to a temporary name first, so a crash never leaves half a file under the real one. */
async function writeAtomic(file: string, data: Buffer | string) {
  await mkdir(config.uploadDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function savePdf(data: Buffer): Promise<string> {
  const hash = sha256(data);
  await writeAtomic(pdfPath(hash), data);
  return hash;
}

/** The one store of transcribed scanned pages: its writes are serialised within an instance only, so a second instance could drop a page. */
export const scanStore = fileScanStore(config.uploadDir);
