import { OCR_VERSION, type OcrPage } from "@dct/harness";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Where a stored PDF lives: one file per content, named by its sha256. */
export const pdfPath = (hash: string) => path.join(config.uploadDir, `${hash}.pdf`);

export const ocrPath = (hash: string) => path.join(config.uploadDir, `${hash}.ocr.json`);

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

export const saveOcr = (hash: string, pages: OcrPage[]) => writeAtomic(ocrPath(hash), JSON.stringify({ version: OCR_VERSION, pages }));

/** What OCR found for this file, or null when there is none, it is unreadable, or an older OCR made it (that scan must be OCR'd again). */
export async function readOcr(hash: string): Promise<OcrPage[] | null> {
  try {
    const saved = JSON.parse(await readFile(ocrPath(hash), "utf8")) as { version?: string; pages?: OcrPage[] };
    return saved.version === OCR_VERSION && Array.isArray(saved.pages) ? saved.pages : null;
  } catch {
    return null;
  }
}
