import { expect, it } from "vitest";
import { authRequired, sign, verify } from "./session";

it("accepts its own cookie, rejects forged, wrong-secret, expired and secret-less ones", async () => {
  const t = await sign("Ann", "s3cret");
  expect(await verify(t, "s3cret")).toBe("Ann");
  expect(await verify(t, "other")).toBeNull();
  expect(await verify(t, undefined)).toBeNull();
  expect(await verify(t.replace("QW5u", "Qm9i"), "s3cret")).toBeNull();
  expect(await verify(t, "s3cret", Date.now() + 8 * 24 * 3600 * 1000)).toBeNull();
  expect(await verify(undefined, "s3cret")).toBeNull();
});

it("is off unless AUTH_REQUIRED is 1", () => {
  expect(authRequired({ AUTH_REQUIRED: "1" } as never)).toBe(true);
  expect(authRequired({} as never)).toBe(false);
  expect(authRequired({ AUTH_REQUIRED: "0" } as never)).toBe(false);
});
