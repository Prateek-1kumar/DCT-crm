import { createCanvas, loadImage } from "@napi-rs/canvas";
import { withPdf } from "../src/pdf/open";
import type { Page } from "../src/types";

// A seeded generator, so every run degrades a page the same way.
const noise = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) * 2 - 1;

/** A text page drawn as a degraded scan: bank details blacked out, grey, blurred, a half degree off square, noisy, and squeezed through JPEG. */
export async function scanOf(path: string, page: Page): Promise<Buffer> {
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
