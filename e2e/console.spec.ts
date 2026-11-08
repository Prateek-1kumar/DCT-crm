import { expect, test, type Page } from "@playwright/test";

// A screen can crash in a real browser while every unit test passes (jsdom hides it: e.g. an effect that returns a value).
// This walks each screen the way a person would and fails on any browser error or on the page's own "ran into a problem"
// screen. Named to sort before flow.spec.ts, so it sees the seeded contract still as a draft with a decision open.
test("no screen throws or logs an error", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });

  const healthy = async (where: string) => {
    await expect(page.getByText("This page ran into a problem"), `${where} shows its error screen`).toHaveCount(0);
    await expect(page.getByText("Something went wrong on this page"), `${where} shows its error screen`).toHaveCount(0);
  };

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible();
  await healthy("the contracts list");

  await page.goto("/how-it-works");
  await healthy("How it works");
  await page.goto("/studies/new");
  await healthy("Add contract");

  await page.goto("/");
  await page.getByRole("link", { name: /EX-101/ }).first().click();
  await expect(page.getByText("Example Pharma").first()).toBeVisible();
  for (const tab of ["Overview", "Budget grid", "Fees & invoiceables", "Payment terms", "Documents", "History"]) {
    await page.getByRole("tab", { name: tab }).click();
    await healthy(`the ${tab} tab`);
  }

  // changing one of the contract's parties opens a picker
  await page.getByRole("button", { name: /^Change Sponsor/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await healthy("the party picker");
  await page.keyboard.press("Escape");

  // the side panel, then its full view
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.locator('[aria-label^="Show in the contract"]').first().click();
  await expect(page.getByRole("button", { name: "Close the contract panel" })).toBeVisible();
  await healthy("the contract side panel");
  await page.getByRole("button", { name: "Expand" }).click();
  await expect(page.getByRole("heading", { name: "Proofread", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /page \d+/i }).first()).toBeVisible();
  await healthy("the Proofread screen");

  const goTo = async (page_: Page, link: string | RegExp, where: string) => {
    await page_.getByRole("link", { name: link }).first().click();
    await page_.waitForLoadState("networkidle");
    await healthy(where);
  };
  await goTo(page, /^Decisions/, "the Decisions screen");
  await goTo(page, "Approve", "the Approve page");
  await goTo(page, "Summary", "the summary");

  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await healthy("the Activity page");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Rename/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await healthy("Settings and its rename dialog");

  expect(problems, "the browser logged errors while walking the screens").toEqual([]);
});
