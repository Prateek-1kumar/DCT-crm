import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

const UNREADABLE = "This file isn't a readable PDF.";

const assets = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const assetUrls = {
  standardFontDataUrl: join(assets, "standard_fonts/"),
  cMapUrl: join(assets, "cmaps/"),
  iccUrl: join(assets, "iccs/"),
  wasmUrl: join(assets, "wasm/"),
};

export async function withPdf<T>(path: string, use: (pdf: PDFDocumentProxy, bytes: Buffer) => Promise<T>): Promise<T> {
  const bytes = await readFile(path).catch(() => {
    throw new Error("This file couldn't be opened. Check that it still exists and try again.");
  });
  if (!bytes.subarray(0, 1024).includes("%PDF-")) throw new Error(UNREADABLE);
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, ...assetUrls });
  let pdf: PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (err) {
    await task.destroy();
    throw new Error(err instanceof Error && err.name === "PasswordException" ? "This PDF is password-protected, so it can't be read." : UNREADABLE);
  }
  try {
    return await use(pdf, bytes);
  } finally {
    await task.destroy();
  }
}
