import { expect, test, type Page } from "@playwright/test";

// The seeded synthetic contract (apps/api/scripts/e2e-seed.ts) from the list to a live rulebook, with no model involved.
const actAs = (page: Page, name: string) => page.evaluate((n) => localStorage.setItem("dct.actingAs", n), name);

test("a read contract is answered, proven against its pages, approved by a second person and shown live", async ({ page }) => {
  await page.goto("/");
  await actAs(page, "Ana Answerer");
  await page.getByRole("link", { name: /EX-101/ }).first().click();
  await expect(page.getByText("Example Pharma").first()).toBeVisible();

  await expect(page.getByRole("heading", { name: /1 decision needs you/ })).toBeVisible();
  await page.getByRole("link", { name: "Answer 1 decision" }).first().click();
  await expect(page).toHaveURL(/\/questions/);
  await expect(page.getByText("How are these paid", { exact: false })).toBeVisible();
  await page.locator("label", { hasText: /invoices/i }).first().click();
  await page.getByRole("button", { name: "Use this answer" }).click();

  await page.getByRole("link", { name: "Proofread", exact: true }).click();
  await expect(page.getByText(/0 missing|Nothing missing/).first()).toBeVisible();
  await expect(page.getByRole("img", { name: /Page 1/i }).first()).toBeVisible();

  await page.getByRole("link", { name: "Approve" }).click();
  await expect(page).toHaveURL(/\/approve/);
  await actAs(page, "Ben Approver");
  await page.reload();
  await expect(page.getByRole("checkbox").first()).toBeVisible();
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: /^Approve/ }).click();
  await expect(page.getByText(/This rulebook is live/).first()).toBeVisible();

  await page.getByRole("link", { name: "Summary", exact: true }).first().click();
  await expect(page).toHaveURL(/\/versions\/[^/]+$/);
  await expect(page.getByText(/Live since/).first()).toBeVisible();
  await expect(page.getByText("$5,000.00").first()).toBeVisible();
});
