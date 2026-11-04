import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type App, multipart, testApp } from "./helpers.js";

let app: App;
beforeAll(async () => {
  app = (await testApp()).app;
});
afterAll(() => app.close());

const get = (url: string) => app.inject({ url: `/api/v1${url}` });

describe("errors never show the database's message", () => {
  it("a server error says what to do, with a reference, not the SQL or its values", async () => {
    const res = await get("/db-error");
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/^Something went wrong on the server\. Try again; if it keeps happening, tell the team \(ref .+\)\.$/);
    expect(res.json().message).toContain(String(res.headers["x-request-id"]));
    expect(res.body).not.toMatch(/select|no_such_table|hunter2|query|params/i);
  });

  it("a value the database can't take is the request's fault (400), never a 500", async () => {
    const res = await get("/db-bad-input");
    expect(res.json()).toMatchObject({ statusCode: 400, message: "Malformed id" });
    expect(res.body).not.toContain("not-a-uuid");
  });
});

describe("ids and version numbers are checked before any route runs", () => {
  it("a malformed id or version is a 400", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await get(`/things/${id}`)).statusCode).toBe(200);
    expect((await get("/things/not-a-uuid")).json()).toMatchObject({ statusCode: 400, message: "Malformed id" });
    expect((await get(`/things/${id}/versions/3`)).statusCode).toBe(200);
    for (const v of ["0", "3000000000", "x"]) expect((await get(`/things/${id}/versions/${v}`)).json()).toMatchObject({ statusCode: 400, message: `Invalid version "${v}"` });
  });
});

describe("request sizes and headers", () => {
  it("refuses a JSON body over 1 MB", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/ping", payload: { by: "x".repeat(2 * 1024 * 1024) } });
    expect(res.statusCode).toBe(413);
  });

  it("an upload of too many files is refused with what to do", async () => {
    const files = Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.pdf`, data: Buffer.from("x") }));
    const { payload, headers } = await multipart(files);
    const res = await app.inject({ method: "POST", url: "/api/v1/upload", payload, headers });
    expect([res.statusCode, res.json().message]).toEqual([413, "Upload at most 50 files at once."]);
  });

  it("JSON is never cached or sniffed, and carries its request id", async () => {
    const res = await get("/ping");
    expect(res.headers).toMatchObject({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
    expect(String(res.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
  });
});
