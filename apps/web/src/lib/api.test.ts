import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
const keysOf = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers["idempotency-key"]);

describe("request", () => {
  it("sends one Idempotency-Key per write, and the same one again when the answer is lost", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(ok({ done: true }));
    vi.stubGlobal("fetch", fetch);
    expect(await request("POST", "/things", { a: 1 })).toEqual({ done: true });
    const keys = keysOf(fetch);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^"[0-9a-f-]{32,36}"$/); // a structured-field string
    fetch.mockResolvedValueOnce(ok({ done: true }));
    await request("POST", "/things", { a: 1 });
    expect(keysOf(fetch)[3]).not.toBe(keys[0]); // a new action, a new key
  });

  it("doesn't retry what the server refused, and reads carry no key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "That is already done." }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(request("POST", "/things", {})).rejects.toMatchObject({ status: 409, message: "That is already done." });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(ok([]));
    await request("GET", "/things");
    expect(keysOf(fetch)[1]).toBeUndefined();
  });

  it("sends a double click once: the same write while the first is waiting shares its request and answer", async () => {
    let answer!: (r: Response) => void;
    const fetch = vi.fn(async () => ok({ n: 1 })).mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    vi.stubGlobal("fetch", fetch);
    const first = request("POST", "/things", { x: 1 });
    const second = request("POST", "/things", { x: 1 }); // a new but identical body, as a second click builds
    const other = request("POST", "/things", { x: 2 }); // a different write is its own action
    expect(fetch).toHaveBeenCalledTimes(2);
    answer(ok({ n: 2 }));
    expect(await first).toEqual({ n: 2 });
    expect(await second).toBe(await first);
    await other;
    // Answered: the same write again is a deliberate new action.
    await request("POST", "/things", { x: 1 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("turns failures into errors a person can read, keeping the request id for the team", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 400, headers: { "x-request-id": "abc-123" } })));
    await expect(request("GET", "/things")).rejects.toMatchObject({ status: 400, requestId: "abc-123" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(request("GET", "/things")).rejects.toMatchObject({ status: 404, message: "That didn't go through. Try again." });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(request("GET", "/things")).rejects.toEqual(new ApiError(0, "Can't reach DCT Finance right now. Check your connection, then try again."));
  });
});
