import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

// The sample server, for the tests that switch sample mode on (the client loads it only then).
const sampleServer = vi.hoisted(() => ({ mockRequest: vi.fn(), mockExport: vi.fn() }));
vi.mock("./mock/server", () => sampleServer);
/** The client as a sample build has it: sample mode is read once, when the module loads. */
async function sampleClient() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_MOCK", "1");
  return import("./api");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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
    await expect(api.signOff("s", 1, { by: "Ben", asOf: "2026-10-29T00:00:00.000Z" })).rejects.toMatchObject({ status: 409, message: "Version 1 is signed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(ok({ makerChecker: false, people: [] }));
    await api.getSettings();
    expect(keysOf(fetch)[1]).toBeUndefined();
  });

  it("send a double click once: the same write while the first is waiting shares its request and answer", async () => {
    let answer!: (r: Response) => void;
    const fetch = vi.fn(async () => ok({ version: 1 })).mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    vi.stubGlobal("fetch", fetch);
    const body = { value: 848900, note: "The page prints 8,489.00", by: "Asha" };
    const first = api.answerReview("s", 1, "confirm:/x", body);
    const second = api.answerReview("s", 1, "confirm:/x", { ...body }); // a new but identical body, as a second click builds
    const other = api.answerReview("s", 1, "confirm:/y", body); // a different write is its own action
    expect(fetch).toHaveBeenCalledTimes(2);
    answer(ok({ version: 1, outcome: "kept" }));
    expect(await first).toEqual({ version: 1, outcome: "kept" });
    expect(await second).toBe(await first);
    await other;
    const [k1, k2] = keysOf(fetch);
    expect(k1).not.toBe(k2);
    // Answered: the same write again is a deliberate new action, with a new key.
    await api.answerReview("s", 1, "confirm:/x", body);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(keysOf(fetch)).size).toBe(3);
  });

  it("share a failed write's error too, then let the next try make a new request", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ message: "Version 2 is already in progress." }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const body = { path: "/payment/netDays/value", note: "Looked wrong", by: "Ben" };
    const both = [api.reportValue("s", 1, body), api.reportValue("s", 1, body)];
    for (const p of both) await expect(p).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(ok({ version: 2 }));
    expect(await api.reportValue("s", 2, body)).toEqual({ version: 2 });
  });

  it("send a double click to the sample server once too", async () => {
    const { mockRequest } = sampleServer;
    mockRequest.mockImplementation(async () => ({ status: 200, json: { version: 3 } }));
    const { api: sample } = await sampleClient();
    const body = { path: "/budgetGrids/0/visits/0/totalCents", value: 123456, by: "Asha" };
    await Promise.all([sample.typeValue("s", 3, body), sample.typeValue("s", 3, body)]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0]![3]).toMatch(/^[0-9a-f-]{32,36}$/);
  });
});

describe("api.exportXlsx", () => {
  const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const download = () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:sheet"), revokeObjectURL: vi.fn() });
    return click;
  };

  it("throws the API's refusal for the screen to show, and downloads nothing", async () => {
    const click = download();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Only an approved version can be exported." }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(api.exportXlsx("s", 2, "Asha")).rejects.toEqual(new ApiError(409, "Only an approved version can be exported."));
    expect(fetch).toHaveBeenCalledTimes(1); // logged on the server, so never retried
    expect(click).not.toHaveBeenCalled();
  });

  it("throws when the API is down (the proxy's bare 500), or can't be reached at all", async () => {
    const click = download();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } })));
    await expect(api.exportXlsx("s", 2, "Asha")).rejects.toMatchObject({ status: 500 });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.exportXlsx("s", 2, "Asha")).rejects.toMatchObject({ status: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    await expect(api.exportXlsx("s", 2, "Asha")).rejects.toMatchObject({ status: 502 });
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads the sheet under the name the API gives it", async () => {
    const click = download();
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([80, 75]), { status: 200, headers: { "content-type": xlsx, "content-disposition": 'attachment; filename="HAL-2207-v2-invoicing-master.xlsx"' } }));
    vi.stubGlobal("fetch", fetch);
    await api.exportXlsx("st 1", 2, "Asha Patel");
    expect(fetch.mock.calls[0]![0]).toBe("/api/v1/studies/st%201/versions/2/export.xlsx?by=Asha+Patel");
    const saved = click.mock.contexts[0] as HTMLAnchorElement;
    expect(saved.download).toBe("HAL-2207-v2-invoicing-master.xlsx");
    expect(saved.href).toBe("blob:sheet");
  });

  it("shows the sample server's refusal as a message too", async () => {
    sampleServer.mockExport.mockRejectedValue(new Error("Only an approved version can be exported."));
    const { api: sample, ApiError: SampleError } = await sampleClient();
    const e = await sample.exportXlsx("s", 2, "Asha").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SampleError);
    expect(e).toMatchObject({ status: 409, message: "Only an approved version can be exported." });
  });
});
