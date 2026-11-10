import { describe, expect, it } from "vitest";
import { isDropped, retryDropped } from "../src/models/retry";

const status = (n: number) => Object.assign(new Error("http"), { status: n });

describe("retryDropped", () => {
  it("asks again when the connection was cut mid-answer", async () => {
    let calls = 0;
    const answer = await retryDropped(async () => {
      if (++calls === 1) throw new TypeError("terminated");
      return "ok";
    }, [0, 0]);
    expect([answer, calls]).toEqual(["ok", 2]);
  });

  it("gives up after its retries and passes the last error on", async () => {
    let calls = 0;
    await expect(retryDropped(() => (calls++, Promise.reject(status(529))), [0, 0])).rejects.toThrow("http");
    expect(calls).toBe(3);
  });

  it("never repeats a request the provider rejected", async () => {
    let calls = 0;
    await expect(retryDropped(() => (calls++, Promise.reject(status(400))), [0, 0])).rejects.toThrow("http");
    expect(calls).toBe(1);
  });

  it("tells drops from other failures", () => {
    expect([new TypeError("terminated"), status(500), status(429), Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } })].map(isDropped)).toEqual([true, true, true, true]);
    expect([new Error("the script has no more replies"), status(401), new TypeError("x is not a function"), "terminated"].map(isDropped)).toEqual([false, false, false, false]);
  });
});
