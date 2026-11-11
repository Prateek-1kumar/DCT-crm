import { describe, expect, it } from "vitest";
import { limit } from "../src/pdf/limit";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("limit", () => {
  it("never runs more than its maximum at once, and finishes every job in order", async () => {
    const run = limit(3);
    let now = 0;
    let most = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        run(async () => {
          most = Math.max(most, ++now);
          await tick();
          now--;
          done.push(i);
        }),
      ),
    );
    expect(most).toBe(3);
    expect(done).toHaveLength(12);
    expect(done.slice(0, 3).sort()).toEqual([0, 1, 2]);
  });

  it("frees the place when a job fails, so later jobs still run", async () => {
    const run = limit(1);
    await expect(run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(run(async () => "ok")).resolves.toBe("ok");
  });
});
