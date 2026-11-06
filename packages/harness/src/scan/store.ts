import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanPage, ScanStore } from "../types";

/**
 * One file per contract file, named by its hash, and one more for the second reads of its pages. Writes go through a
 * temporary file and a rename, so a crash never leaves half a file.
 */
export function fileScanStore(dir: string): ScanStore {
  return { ...pagesIn(dir, "scan"), verify: pagesIn(dir, "verify") };
}

function pagesIn(dir: string, kind: string): ScanStore {
  const file = (sha256: string) => join(dir, `${sha256}.${kind}.json`);
  // each put reads the file and writes it back, so puts to one file must not overlap
  const queues = new Map<string, Promise<void>>();

  async function get(sha256: string): Promise<ScanPage[]> {
    try {
      // pages saved before transcriptions were kept hold words only; they count as not read
      const saved = JSON.parse(await readFile(file(sha256), "utf8")) as Partial<ScanPage>[];
      return saved.filter((p): p is ScanPage => !!p.transcription);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  return {
    get,
    put(sha256, page) {
      const write = (queues.get(sha256) ?? Promise.resolve()).then(async () => {
        const kept = (await get(sha256)).filter((p) => p.page !== page.page);
        await mkdir(dir, { recursive: true });
        const temporary = `${file(sha256)}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify([...kept, page]));
        await rename(temporary, file(sha256));
      });
      queues.set(sha256, write.catch(() => undefined));
      return write;
    },
  };
}
