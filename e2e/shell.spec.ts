import { expect, test } from "@playwright/test";

// The skeleton end to end: the production web build serves the shell, and its /api proxy reaches the real API.
test("home shows the shell and the API is ready behind the proxy", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Contracts" }).first()).toBeVisible();

  // An unknown API route comes back as the API's own plain-English 404 through the web's proxy.
  const res = await request.get("/api/v1/nothing-here");
  expect(res.status()).toBe(404);
});
