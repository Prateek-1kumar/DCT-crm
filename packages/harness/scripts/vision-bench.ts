// Scores ways of reading scanned pages against an answer key: pages that have a real text layer are drawn as degraded
// scans (bank details blacked out first), read by vision models, and compared with their own text. Prints numbers only.
//   pnpm vision-bench --cap 8 --out <dir> "a.pdf:6,7" "b.pdf:24"
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import OpenAI from "openai";
import { amountsIn } from "../src/checks/text";
import { claudeReader, estimateUsd, openaiReader } from "../src/models";
import { pdfReader } from "../src/pdf";
import { groupLines, rawLine } from "../src/pdf/lines";
import { withPdf } from "../src/pdf/open";
import type { Page } from "../src/types";
import { compareReadings, moneyRows, type MoneyRow } from "../src/vision/compare";
import { settle } from "../src/vision/settle";
import { pageParts, review, transcribe, type Transcription } from "../src/vision/transcribe";

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

const claude = claudeReader(new Anthropic(), process.env.HARNESS_MODEL ?? "claude-sonnet-5-5");
const gpt = openaiReader(new OpenAI(), process.env.OPENAI_MODEL!);
let spent = 0;
const cost = new Map<string, number>();

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
  const step = name.replace(/^f\d+p\d+-/, "");
  cost.set(step, (cost.get(step) ?? 0) + saved.usd);
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

interface Score { truth: number; right: number; wrong: number; asked: number; missed: number; rows: number; rowsRight: number; questions: number }
const zero = (): Score => ({ truth: 0, right: 0, wrong: 0, asked: 0, missed: 0, rows: 0, rowsRight: 0, questions: 0 });

function take(pool: Map<number, number>, cents: number) {
  const left = pool.get(cents) ?? 0;
  if (left > 0) pool.set(cents, left - 1);
  return left > 0;
}

/** Accepted rows go into the rulebook unasked; asked rows reach a person, who reads them right. */
function score(truthRows: number[][], accepted: MoneyRow[], asked: MoneyRow[]): Score {
  const pool = new Map<number, number>();
  for (const c of truthRows.flat()) pool.set(c, (pool.get(c) ?? 0) + 1);
  const amounts = (rows: MoneyRow[]) => rows.flatMap((r) => r.cents.filter((c): c is number => c !== null));
  const takenAccepted = amounts(accepted).map((c) => take(pool, c));
  const right = takenAccepted.filter(Boolean).length;
  const askedRight = amounts(asked).filter((c) => take(pool, c)).length;
  const seqs = accepted.map((r) => JSON.stringify(r.cents.filter((c) => c !== null)));
  const rowsRight = truthRows.filter((t) => {
    const at = seqs.indexOf(JSON.stringify(t));
    if (at !== -1) seqs.splice(at, 1);
    return at !== -1;
  }).length;
  const truth = truthRows.flat().length;
  return { truth, right, wrong: takenAccepted.length - right, asked: askedRight, missed: truth - right - askedRight, rows: truthRows.length, rowsRight, questions: asked.length };
}

const totals: Record<string, Score> = {};
let dryUsd = 0;
const add = (arm: string, s: Score) => {
  const t = (totals[arm] ??= zero());
  for (const k of Object.keys(s) as (keyof Score)[]) t[k] += s[k];
};
const show = (s: Score) =>
  `truth=${s.truth} right=${s.right} wrongAccepted=${s.wrong} asked=${s.asked} missed=${s.missed} rowsRight=${s.rowsRight}/${s.rows} questions=${s.questions}`;

for (const [fileIndex, spec] of args.entries()) {
  const at = spec.lastIndexOf(":");
  const path = spec.slice(0, at);
  const doc = await pdfReader.load(path);
  for (const n of spec.slice(at + 1).split(",").map(Number)) {
    const page = doc.pages[n - 1]!;
    const truthRows = groupLines(page.words).map((l) => amountsIn(rawLine(l))).filter((r) => r.length);
    const png = await scanOf(path, page);
    const id = `f${fileIndex + 1}p${n}`;
    if (dry) {
      await writeFile(join(out, `${id}.png`), png);
      // ponytail: output guessed at ~30 tokens an amount plus layout; the real run reports actual spend
      const parts = await pageParts(png);
      const output = truthRows.flat().length * 30 + 1500;
      const usd = estimateUsd(claude, parts, output) + 2 * estimateUsd(gpt, parts, output * 2);
      dryUsd += usd;
      console.log(`${id}: amounts=${truthRows.flat().length} rows=${truthRows.length} images=${parts.filter((p) => p.type === "image").length} estimate=$${usd.toFixed(2)}`);
      continue;
    }
    try {
      const [a, b] = await Promise.all([
        cached<Transcription>(`${id}-claude`, () => transcribe(claude, png)),
        cached<Transcription>(`${id}-gpt`, () => transcribe(gpt, png)),
      ]);
      const reviewed = await cached<Transcription>(`${id}-gpt-review`, () => review(gpt, png, a));
      const [ra, rb, rc] = [moneyRows(a), moneyRows(b), moneyRows(reviewed)];

      const arms: [string, Score][] = [
        ["A claude alone", score(truthRows, ra.filter((r) => !r.doubtful), ra.filter((r) => r.doubtful))],
        ["B gpt alone", score(truthRows, rb.filter((r) => !r.doubtful), rb.filter((r) => r.doubtful))],
      ];
      for (const [arm, other, name] of [["C cooperative", rc, "coop"], ["D independent+converge", rb, "conv"]] as const) {
        const { agreed, disputes } = compareReadings(ra, other);
        const result = await cached(`${id}-settle-${name}`, async () => {
          const r = disputes.length ? await settle(claude, gpt, png, disputes) : { settled: [], questions: [], usd: 0 };
          return { value: { settled: r.settled.map((s) => s.row), questions: r.questions.map((q) => (q.a ?? q.b)!) }, usd: r.usd };
        });
        arms.push([arm, score(truthRows, [...agreed, ...result.settled], result.questions)]);
      }
      for (const [arm, s] of arms) {
        add(arm, s);
        console.log(`${id} ${arm}: ${show(s)}`);
      }
    } catch (err) {
      console.log(`${id}: ${err instanceof Error ? err.message : "failed"}`);
      if (spent >= cap) break;
    }
  }
}

for (const [arm, s] of Object.entries(totals)) console.log(`TOTAL ${arm}: ${show(s)}`);
if (dry) console.log(`estimate before settling: $${dryUsd.toFixed(2)}`);
const of = (...steps: string[]) => steps.reduce((n, step) => n + (cost.get(step) ?? 0), 0);
console.log(`cost A=$${of("claude").toFixed(2)} B=$${of("gpt").toFixed(2)} C=$${of("claude", "gpt-review", "settle-coop").toFixed(2)} D=$${of("claude", "gpt", "settle-conv").toFixed(2)}`);
console.log(`spent this run: $${spent.toFixed(2)}`);
