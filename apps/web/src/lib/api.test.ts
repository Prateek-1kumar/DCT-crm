import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
const keysOf = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers["idempotency-key"]);

describe("api writes", () => {
  it("send one Idempotency-Key per action, and the same one again when the answer is lost", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(ok({ unread: 0 }));
    vi.stubGlobal("fetch", fetch);
    expect(await api.readAlerts({ by: "Asha" })).toEqual({ unread: 0 });
    const keys = keysOf(fetch);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^"[0-9a-f-]{32,36}"$/); // a structured-field string
    fetch.mockResolvedValueOnce(ok({ unread: 0 }));
    await api.readAlerts({ by: "Asha" });
    expect(keysOf(fetch)[3]).not.toBe(keys[0]); // a new action, a new key
  });

  it("don't retry what the server refused, and reads carry no key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Version 1 is signed" }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(api.signOff("s", 1, { by: "Ben" })).rejects.toMatchObject({ status: 409, message: "Version 1 is signed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(ok({ makerChecker: false, people: [] }));
    await api.getSettings();
    expect(keysOf(fetch)[1]).toBeUndefined();
  });
});
