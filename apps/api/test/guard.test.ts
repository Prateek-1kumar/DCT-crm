import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type App, testApp } from "./helpers.js";

let app: App;
beforeAll(async () => {
  app = (await testApp()).app;
});
afterAll(() => app.close());

describe("host and origin guard", () => {
  it("rejects a foreign Host (DNS rebinding)", async () => {
    const res = await app.inject({ url: "/api/v1/ping", headers: { host: "evil.example:4100" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Host not allowed");
  });

  it("rejects a foreign Origin on mutating requests", async () => {
    for (const origin of ["https://evil.example", "null"]) {
      const res = await app.inject({ method: "POST", url: "/api/v1/ping", headers: { host: "127.0.0.1:4100", origin }, payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toBe("Origin not allowed");
    }
  });

  it("lets allowed requests through", async () => {
    expect((await app.inject({ url: "/api/v1/ping", headers: { host: "127.0.0.1:4100", origin: "https://evil.example" } })).statusCode).toBe(200);
    const write = await app.inject({ method: "POST", url: "/api/v1/ping", headers: { host: "127.0.0.1:4100", origin: "http://localhost:3100" }, payload: {} });
    expect(write.statusCode).toBe(200);
    // no Origin (curl, server-side proxy without one) is fine
    expect((await app.inject({ method: "POST", url: "/api/v1/ping", headers: { host: "127.0.0.1:4100" }, payload: {} })).statusCode).toBe(200);
  });

  it("holds behind the web app's proxy: a foreign browser Host (X-Forwarded-Host) is refused", async () => {
    const res = await app.inject({ url: "/api/v1/ping", headers: { host: "127.0.0.1:4100", "x-forwarded-host": "evil.example:3100" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Host not allowed");
    expect((await app.inject({ url: "/api/v1/ping", headers: { host: "127.0.0.1:4100", "x-forwarded-host": "127.0.0.1:4100" } })).statusCode).toBe(200);
  });
});
