// Scores how well the OpenAI reader transcribes scanned pages: pages that have a real text layer are drawn as degraded
// scans (bank details blacked out first), transcribed, and their amounts compared with the text layer's. Prints numbers only.
//   pnpm vision-bench --cap 8 --out <dir> "a.pdf:6,7" "b.pdf:24"
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import OpenAI from "openai";
import { amountsAt, amountsIn } from "../src/checks/text";
import { estimateUsd, openaiReader } from "../src/models";
import { pdfReader } from "../src/pdf";
import { groupLines, rawLine } from "../src/pdf/lines";
import { withPdf } from "../src/pdf/open";
import { pageParts, transcribe, type Transcription } from "../src/scan/transcribe";
import { toWords } from "../src/scan/words";
import type { Page, Word } from "../src/types";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args.splice(at, 2)[1];
};
const cap = Number(flag("--cap") ?? 8);
const dry = args.includes("--dry") && args.splice(args.indexOf("--dry"), 1).length > 0;
const out = flag("--out");
if (!out || !args.length) throw new Error('usage: vision-bench.ts --cap 8 --out <dir> "file.pdf:6,7" ...');
await mkdir(out, { recursive: true });

const gpt = openaiReader(new OpenAI(), process.env.OPENAI_MODEL!);
let spent = 0;

async function cached<T>(name: string, run: () => Promise<{ value: T; usd: number }>): Promise<T> {
  const file = join(out!, `${name}.json`);
  let saved: { value: T; usd: number };
  if (existsSync(file)) saved = JSON.parse(await readFile(file, "utf8")) as { value: T; usd: number };
  else {
    if (spent >= cap) throw new Error(`stopped at the $${cap} cap ($${spent.toFixed(2)} spent)`);
    saved = await run();
    spent += saved.usd;
    await writeFile(file, JSON.stringify(saved));
  }
  return saved.value;
}

// A seeded generator, so every run degrades a page the same way.
const noise = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) * 2 - 1;

async function scanOf(path: string, page: Page): Promise<Buffer> {
  return withPdf(path, async (pdf) => {
    const p = await pdf.getPage(page.page);
    const vp = p.getViewport({ scale: 200 / 72 });
    const clean = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    await p.render({ canvas: clean as unknown as HTMLCanvasElement, viewport: vp }).promise;
    const c = clean.getContext("2d");
    c.fillStyle = "#000";
    for (const [x0, y0, x1, y1] of page.maskBoxes) c.fillRect(x0 * clean.width, y0 * clean.height, (x1 - x0) * clean.width, (y1 - y0) * clean.height);

    const scan = createCanvas(clean.width, clean.height);
    const s = scan.getContext("2d");
    s.fillStyle = "#fff";
    s.fillRect(0, 0, scan.width, scan.height);
    s.filter = "grayscale(1) blur(0.6px)";
    s.translate(scan.width / 2, scan.height / 2);
    s.rotate((0.5 * Math.PI) / 180);
    s.drawImage(clean, -clean.width / 2, -clean.height / 2);
    const data = s.getImageData(0, 0, scan.width, scan.height);
    const rand = noise(page.page);
    for (let i = 0; i < data.data.length; i += 4) {
      const v = Math.max(0, Math.min(255, data.data[i]! + rand() * 22));
      data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    }
    s.putImageData(data, 0, 0);
    const jpeg = await loadImage(await scan.encode("jpeg", 55));
    const final = createCanvas(jpeg.width, jpeg.height);
    final.getContext("2d").drawImage(jpeg, 0, 0);
    return final.encode("png");
  });
}

interface Score { truth: number; right: number; wrong: number; missed: number }

const amountsPerLine = (words: Word[]) => groupLines(words).flatMap((line) => amountsIn(rawLine(line)));

function score(truth: number[], read: number[]): Score {
  const pool = new Map<number, number>();
  for (const c of truth) pool.set(c, (pool.get(c) ?? 0) + 1);
  const right = read.filter((c) => {
    const left = pool.get(c) ?? 0;
    if (left > 0) pool.set(c, left - 1);
    return left > 0;
  }).length;
  return { truth: truth.length, right, wrong: read.length - right, missed: truth.length - right };
}

const total: Score = { truth: 0, right: 0, wrong: 0, missed: 0 };
let dryUsd = 0;
const show = (s: Score) => `truth=${s.truth} right=${s.right} wrong=${s.wrong} missed=${s.missed}`;

for (const [fileIndex, spec] of args.entries()) {
  const at = spec.lastIndexOf(":");
  const path = spec.slice(0, at);
  const doc = await pdfReader.load(path);
  for (const n of spec.slice(at + 1).split(",").map(Number)) {
    const page = doc.pages[n - 1]!;
    const id = `f${fileIndex + 1}p${n}`;
    if (!amountsAt(page.raw).some((a) => a.text.includes("$"))) {
      console.log(`${id}: skipped, no dollar amounts`);
      continue;
    }
    const truth = amountsPerLine(page.words);
    const png = await scanOf(path, page);
    if (dry) {
      await writeFile(join(out, `${id}.png`), png);
      // ponytail: output guessed at ~30 tokens an amount plus layout; the real run reports actual spend
      const parts = await pageParts(png);
      const usd = estimateUsd(gpt, parts, truth.length * 30 + 1500);
      dryUsd += usd;
      console.log(`${id}: amounts=${truth.length} images=${parts.filter((p) => p.type === "image").length} estimate=$${usd.toFixed(2)}`);
      continue;
    }
    try {
      const read = toWords(await cached<Transcription>(`${id}-gpt`, () => transcribe(gpt, png)));
      const s = score(truth, amountsPerLine(read));
      for (const k of Object.keys(s) as (keyof Score)[]) total[k] += s[k];
      console.log(`${id}: ${show(s)}`);
    } catch (err) {
      if (spent >= cap) {
        console.log(`${id}: stopped at the $${cap} cap ($${spent.toFixed(2)} spent)`);
        break;
      }
      console.log(`${id}: failed (${err instanceof Error ? err.name : "unknown error"})`);
    }
  }
}

if (dry) console.log(`estimate: $${dryUsd.toFixed(2)}`);
else console.log(`TOTAL: ${show(total)}`);
console.log(`spent this run: $${spent.toFixed(2)}`);
