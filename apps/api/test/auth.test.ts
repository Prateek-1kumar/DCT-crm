import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { type App, type Built, testApp } from "./helpers.js";

let built: Built;
let app: App;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());

const login = (payload: object) => app.inject({ method: "POST", url: "/api/v1/auth/login", payload });

describe("POST /auth/login", () => {
  it("accepts the right password in any letter case of the name, and refuses a wrong password or an unknown name alike", async () => {
    const name = `ann-${randomUUID().slice(0, 8)}`;
    await built.ctx.db.insert(users).values({ name, displayName: "Ann Lee", passwordHash: await hashPassword("s3cret-pw") });

    const ok = await login({ name: ` ${name.toUpperCase()} `, password: "s3cret-pw" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ name, displayName: "Ann Lee" });

    const wrong = await login({ name, password: "nope" });
    const unknown = await login({ name: "nobody-here", password: "s3cret-pw" });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json().message).toBe(unknown.json().message);
    expect(wrong.body).not.toContain("s3cret-pw");
  });

  it("asks for what's missing in plain words", async () => {
    const res = await login({ name: "ann" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Enter your password.");
  });
});
