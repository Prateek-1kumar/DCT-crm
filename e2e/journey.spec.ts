import { readFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * Today's journey, against the real API (EXTRACTION_FAKE=1 fakes only the AI) and a production build of the web in real
 * mode: add a contract → reading → answering (with a mismatch) → proofreading → approval → live → search and ⌘K → export →
 * amendment → "This looks wrong" → send back → alerts. The PDFs are synthetic, printed by the browser: a text PDF whose
 * numbers match the fake reading, so most of them are confirmed against the PDF's own text, as with a DocuSign copy.
 */

type Pdf = { name: string; mimeType: string; buffer: Buffer };

const STYLE = `<style>
  body { font-family: Helvetica, Arial, sans-serif; font-size: 12px; }
  .page { page-break-after: always; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  td, th { padding: 6px 8px; text-align: left; border-bottom: 1px solid #999; }
  .n { text-align: right; }
</style>`;
const PROSE =
  "This work order sets out the payments the Sponsor, Synthetic Pharma, makes to the Institution for the clinical study named in the agreement. The Institution invoices the Sponsor for the items below, naming the protocol, with the supporting documents the Sponsor asks for.";

/**
 * One titled budget table per grid the fake reading has, as a contract prints an exhibit and its revision: one printed
 * row backs one grid's cells at most. Both print Week 0 at $8,488.00; the reading has 8,489.00 for "Exhibit A", the
 * mismatch answered below.
 */
const GRID = (title: string) => `
  <h2>${title}</h2>
  <table>
    <tr><th>Procedure</th><th>Code</th><th class="n">Unit</th><th class="n">Screening</th><th class="n">Week 0</th></tr>
    <tr><td>Blood draw</td><td>36415</td><td class="n">$55.00</td><td class="n">$55.00</td><td class="n">$55.00</td></tr>
    <tr><td>Procedure subtotal</td><td></td><td></td><td class="n">$3,801.00</td><td class="n">$4,047.00</td></tr>
    <tr><td>Overhead</td><td></td><td></td><td class="n">$2,130.00</td><td class="n">$2,425.00</td></tr>
    <tr><td>Non-procedure</td><td></td><td></td><td class="n">$1,524.00</td><td class="n">$2,016.00</td></tr>
    <tr><td>Visit total</td><td></td><td></td><td class="n">$7,455.00</td><td class="n">$8,488.00</td></tr>
  </table>
  <p>Total $15,943.00</p>`;

/** The fake reading's fees on page 1 and its grids on page 2. Rules (days, %, dates) aren't printed: the fake gives no quote for them, so they're asked. */
const WORK_ORDER = `${STYLE}
<div class="page">
  <h1>Work Order</h1><p>${PROSE}</p>
  <table>
    <tr><th>Item</th><th>Code</th><th class="n">Amount</th><th class="n">With overhead</th></tr>
    <tr><td>Unscheduled visit</td><td>UNSCH</td><td class="n">$572.00</td><td class="n">$800.00</td></tr>
    <tr><td>Administrative fee</td><td>SC003</td><td class="n">$12,000.00</td><td></td></tr>
    <tr><td>Screen failure</td><td></td><td class="n">$7,455.00</td><td></td></tr>
  </table>
  <p>Payments are made in United States dollars, by electronic funds transfer to the account the Institution names in writing.</p>
</div>
<div class="page">
  <h1>Exhibit A: Budget</h1>
  <p>The per patient payments below include institutional overhead (40%) on each procedure. Visits are paid automatically from the electronic data capture system once the case report forms for the visit are accepted by the Sponsor.</p>
  ${["Exhibit A", "Exhibit A (revised)"].map((title) => GRID(title)).join("")}
</div>`;

const AMENDMENT = `${STYLE}
<div class="page">
  <h1>Amendment 1</h1><p>${PROSE}</p>
  <p>This amendment changes the payment for an unscheduled visit and adds a start-up fee. Everything else in the work order stays as it is.</p>
</div>`;

async function printPdf(browser: Browser, name: string, html: string): Promise<Pdf> {
  const p = await browser.newPage();
  await p.setContent(html);
  const buffer = await p.pdf({ format: "Letter" });
  await p.close();
  return { name, mimeType: "application/pdf", buffer };
}

/** Browser errors (CSP violations included), failed API calls and server errors, checked at the end. */
async function watch(page: Page) {
  const problems: string[] = [];
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // A 4xx the test asks for on purpose shows as "Failed to load resource"; its response is checked below instead.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return problems;
}

/** The answer to each question the fake reading of WORK_ORDER asks, by its wording. */
const ANSWERS: [RegExp, { type: string } | { pick: RegExp }][] = [
  [/effective date/, { type: "2025-08-22" }],
  [/overhead percentage/, { type: "40" }],
  [/how many days must an invoice be paid/, { type: "45" }],
  [/months after the study closes/, { type: "6" }],
  [/"Administrative fee" due/, { type: "45" }],
  [/screen failures can be billed/, { type: "7" }],
  [/Master CTA/, { pick: /doesn't affect billing/ }],
  [/bill from/, { pick: /Exhibit A \(revised\)/ }],
];

/** Clicks a button that sends an answer, and waits until the API has taken it. */
async function send(page: Page, name: string) {
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && /\/versions\/\d+\/review\/[^/]+$/.test(new URL(r.url()).pathname));
  await page.getByRole("button", { name }).click();
  expect((await saved).ok()).toBe(true);
}

/** Answers the open question on the review page from ANSWERS. */
async function answer(page: Page, question: string) {
  const a = ANSWERS.find(([q]) => q.test(question))?.[1];
  if (!a) throw new Error(`No answer in the test for: ${question}`);
  if ("type" in a) await page.getByLabel("What the contract says").fill(a.type);
  else await page.getByRole("radio", { name: a.pick }).check();
  await send(page, "Save and next");
}

const questionHeading = (page: Page) => page.getByRole("region", { name: "Question" }).getByRole("heading", { level: 1 });

/** Answers every open question on the review page with `reply`, one at a time, until the finished screen. */
async function answerAll(page: Page, reply: (question: string) => Promise<void>) {
  const finished = page.getByRole("heading", { name: /Every question has an answer|Almost done/ });
  const region = page.getByRole("region", { name: "Question" });
  for (let n = 0; n < 30 && !(await finished.isVisible()); n++) {
    // Two questions can read the same (one per grid), so "moved on" is judged by the whole panel, its "n of m" included.
    const before = await region.textContent();
    await reply((await questionHeading(page).textContent())!);
    await expect
      .poll(async () => {
        if (await finished.isVisible()) return true;
        const now = (await region.textContent())!;
        return now !== before && !now.includes("Saving…");
      })
      .toBe(true);
  }
  await expect(finished).toBeVisible();
}

async function actAs(page: Page, name: string) {
  await page.getByRole("button", { name: /Choose your name|Working now/ }).first().click();
  await page.getByRole("dialog", { name: "Who's working today?" }).getByRole("button", { name }).click();
  await expect(page.getByRole("dialog", { name: "Who's working today?" })).toBeHidden();
}

test("add a contract → answer → proofread → approve → live → search → export → amend → report → send back → alerts", async ({ page, browser, context, request }) => {
  const problems = await watch(page);
  const workOrder = await printPdf(browser, "Work order.pdf", WORK_ORDER);
  let studyUrl = "";

  await test.step("security headers on every page", async () => {
    const res = await page.goto("/");
    const h = res!.headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"]).not.toContain("unsafe-eval");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("same-origin");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  await test.step("missing pages read as such", async () => {
    await page.goto("/no-such-page");
    await expect(page.getByRole("heading", { name: "There's no page here" })).toBeVisible();
    await page.goto("/studies/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("heading", { name: "We can't find this contract" })).toBeVisible();
    await page.getByRole("link", { name: "Back to contracts" }).click();
    await expect(page.getByRole("heading", { name: "No contracts yet" })).toBeVisible();
  });

  await test.step("people, and who's working", async () => {
    await page.goto("/settings");
    // Nobody is picked yet, so the name picker opens by itself; there's nobody to pick until people are added.
    const picker = page.getByRole("dialog", { name: "Who's working today?" });
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    for (const n of ["Asha Patel", "Ben Okafor"]) {
      await page.getByLabel("New person's name").fill(n);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("listitem").filter({ hasText: n })).toBeVisible();
    }
    await actAs(page, "Asha Patel");
  });

  await test.step("add a contract", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Add your first contract" }).click();
    await page.locator('input[type="file"]').setInputFiles(workOrder);
    const file = page.getByRole("listitem").filter({ hasText: "Work order.pdf" });
    await expect(file.getByText("Text PDF, numbers can be checked")).toBeVisible();
    await expect(file.getByLabel("What kind of file Work order.pdf is")).toHaveValue("other");
    await file.getByLabel("What kind of file Work order.pdf is").selectOption("work_order");
    await expect(file.getByLabel("What kind of file Work order.pdf is")).toHaveValue("work_order");
    await page.getByRole("button", { name: "Continue with 1 file" }).click();
    // The cover pages are read for the details, which wait to be checked.
    await expect(page.getByLabel("Sponsor")).toHaveValue("Synthetic Pharma", { timeout: 30_000 });
    await expect(page.getByLabel("Protocol number")).toHaveValue("SYN-001");
    await page.reload(); // the study is in the URL: a refresh picks up where it was
    await expect(page.getByLabel("Principal investigator")).toHaveValue("Dr. Test");
    await page.getByRole("button", { name: "Start reading" }).click();
  });

  await test.step("reading and checking", async () => {
    await page.waitForURL(/\/reading\?job=/);
    await expect(page.getByRole("heading", { name: "Read and checked" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("numbers match the contract PDF")).toBeVisible();
    studyUrl = new URL(page.url()).pathname.replace(/\/reading$/, "");
    await page.getByRole("link", { name: "Start answering" }).click();
    await page.waitForURL(/\/review/);
  });

  await test.step("answering, blind, with a mismatch", async () => {
    // The page shows the spot, never our reading.
    await expect(page.getByRole("region", { name: "The spot in the contract" }).getByRole("img").first()).toBeVisible();
    let mismatch = false;
    await answerAll(page, async (q) => {
      if (!/Week 0 total/.test(q)) return answer(page, q);
      // Type the AI's figure; the PDF's own text says otherwise, so the page asks which one it shows.
      await page.getByLabel("What the contract says").fill("8,489.00");
      await send(page, "Save and next");
      await expect(page.getByText(/^Look at the close-up again\./)).toBeVisible();
      await page.getByRole("radio", { name: /PDF text says.*\$8,488\.00/ }).click();
      await send(page, "Save and next");
      mismatch = true;
    });
    expect(mismatch).toBe(true);
    await expect(page.getByRole("heading", { name: "Every question has an answer" })).toBeVisible();
  });

  await test.step("proofreading the checked numbers", async () => {
    await page.goto(`${studyUrl}/proofread`);
    const done = page.getByRole("heading", { name: "Everything is proofread" });
    const tally = page.getByText(/ numbers proofread$/);
    await expect(tally).toHaveText(/^0 of \d+ numbers proofread$/);
    for (let n = 0; n < 30 && !(await done.isVisible()); n++) {
      const before = await tally.textContent();
      await page.getByRole("button", { name: "Looks right" }).click();
      await expect.poll(async () => (await done.isVisible()) || (await tally.textContent()) !== before).toBe(true);
    }
    await expect(done).toBeVisible();
    await page.getByRole("link", { name: "Back to the contract" }).click();
  });

  await test.step("approval, signed with initials", async () => {
    await page.getByRole("link", { name: "Review and approve" }).click();
    // Every question is answered, so it opens on the key terms.
    await expect(page.getByRole("heading", { name: "Check the key terms" })).toBeVisible();
    const terms = page.getByRole("checkbox");
    for (let i = 0; i < (await terms.count()); i++) await terms.nth(i).click();
    await page.getByRole("button", { name: "Next: approve" }).click();
    const sign = page.getByRole("button", { name: "Approve invoicing master" });
    await expect(sign).toBeDisabled();
    await page.getByLabel("Type AP to sign as Asha Patel").fill("ap");
    await sign.click();
    await expect(page.getByRole("heading", { name: "Approved. Version 1 is live." })).toBeVisible();
    await page.goto(studyUrl);
    await expect(page.getByText("Live: version 1")).toBeVisible();
  });

  await test.step("live: tabs and the value drawer by keyboard", async () => {
    const tabs = page.getByRole("tablist", { name: "Invoicing master" });
    await tabs.getByRole("tab", { name: "Overview" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Budget grid" })).toHaveAttribute("aria-selected", "true");
    await expect(tabs.getByRole("tab", { name: "Budget grid" })).toBeFocused();
    // The tab opens on the grid billing uses, the revised Exhibit A picked when answering.
    const cell = page.locator('[data-path="/budgetGrids/1/procedures/0/cells/V1"]');
    await cell.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("complementary", { name: /In the contract/ });
    await expect(drawer).toBeFocused();
    await expect(drawer.getByText("Matches the PDF.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(cell).toBeFocused();
  });

  await test.step("search in the contract and ⌘K", async () => {
    await page.getByLabel("Search this contract").fill("blood");
    await expect(page.getByText(/^\d+ match(es)?:$/)).toBeVisible();
    await page.getByLabel("Search this contract").fill("");

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Search" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox", { name: "Search" }).fill("blood draw");
    const rate = palette.getByRole("option", { name: /Blood draw/ }).first();
    await expect(rate).toBeVisible();
    while ((await rate.getAttribute("aria-selected")) !== "true") await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.getByRole("complementary", { name: /Blood draw/ })).toBeVisible();
    await page.getByRole("complementary", { name: /Blood draw/ }).getByRole("button", { name: "Close" }).click();
  });

  await test.step("export: Excel and the printable summary", async () => {
    const button = page.getByRole("button", { name: "Export" });
    // A menu button: arrow down opens it on the first choice, Escape closes it back to the button.
    await button.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: /Excel spreadsheet/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(button).toBeFocused();

    await button.click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /Excel spreadsheet/ }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    expect(readFileSync((await download.path())!).subarray(0, 2).toString()).toBe("PK"); // an xlsx is a zip

    await button.click();
    const [summary] = await Promise.all([context.waitForEvent("page"), page.getByRole("menuitem", { name: /PDF summary/ }).click()]);
    await expect(summary.getByText("Invoicing master · summary")).toBeVisible();
    await expect(summary.getByRole("heading", { name: "SYN-001" })).toBeVisible();
    await summary.close();
  });

  await test.step("amendment: a new version while version 1 stays live", async () => {
    await page.getByRole("link", { name: "Upload amendment" }).click();
    await page.locator('input[type="file"]').setInputFiles(await printPdf(browser, "Amendment 1.pdf", AMENDMENT));
    const kind = page.getByLabel("What kind of file Amendment 1.pdf is");
    await expect(kind).toBeVisible();
    await kind.selectOption("amendment");
    await expect(kind).toHaveValue("amendment");
    await page.getByRole("button", { name: /Start reading/ }).click();
    await expect(page.getByRole("heading", { name: "Read and checked" })).toBeVisible({ timeout: 60_000 });
    await page.goto(studyUrl);
    await expect(page.getByText("A new version is in progress. Version 1 stays live until it's approved.")).toBeVisible();
    await expect(page.getByText("Live: version 1")).toBeVisible();
  });

  await test.step("“This looks wrong” goes to the version in progress", async () => {
    const report = async (card: RegExp) => {
      await page.getByRole("tab", { name: "Overview" }).click();
      await page.getByRole("button", { name: card }).click();
      await page.getByRole("complementary", { name: /In the contract/ }).getByRole("button", { name: "This looks wrong" }).click();
      const dialog = page.getByRole("dialog", { name: "This looks wrong" });
      await expect(dialog.getByLabel("What looks wrong? (required)")).toBeFocused();
      await dialog.getByLabel("What looks wrong? (required)").fill("The total on page 2 doesn't match the visits above it.");
      await dialog.getByRole("button", { name: "Report it" }).click();
      return dialog;
    };
    // On live version 1 while version 2 is in progress: refused, in words.
    const refused = await report(/^Per patient/);
    await expect(refused.getByRole("alert")).toContainText("Version 2 is already in progress");
    await page.keyboard.press("Escape");
    await expect(refused).toBeHidden();
    await page.keyboard.press("Escape"); // and the drawer
    await page.getByRole("combobox", { name: /^Version/ }).selectOption("2");
    // On the draft, a value still waiting for its blind answer shows as such, not as missing.
    await expect(page.getByRole("button", { name: /^Payment Needs you/ })).toBeVisible();
    await report(/^Per patient/);
    await expect(page.getByText("Added to Needs you. Someone will type what the contract says.")).toBeVisible();
  });

  let sentBack = "";
  await test.step("answer version 2, then the approver sends one answer back", async () => {
    await page.goto(`${studyUrl}/review`);
    await answerAll(page, async (q) => {
      if (/how many days must an invoice be paid/.test(q)) return answer(page, q);
      if (/printed for "Total"/.test(q)) {
        // The value reported above, typed blind.
        await page.getByLabel("What the contract says").fill("15,943.00");
        return send(page, "Save and next");
      }
      // Whatever else the amendment asks is left for the approver.
      await page.getByRole("button", { name: "Can't tell" }).click();
      await send(page, "Leave it for the approver");
    });
    await page.goto(`${studyUrl}/approve`);
    const answered = page.getByRole("checkbox", { name: /Send back: Within how many days must an invoice be paid/ });
    sentBack = (await answered.getAttribute("aria-label"))!.replace(/^Send back: /, "");
    await answered.check();
    await page.getByRole("button", { name: "Send 1 back" }).click();
    const dialog = page.getByRole("dialog", { name: "Send 1 answer back" });
    await dialog.getByLabel("What should they look at again?").fill("Check the payment terms page again.");
    await dialog.getByRole("button", { name: "Send back" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("alerts: another person sees what needs them", async () => {
    await page.goto("/");
    await actAs(page, "Ben Okafor");
    const bell = page.getByRole("button", { name: /^Alerts, \d+ unread$/ }).first();
    await expect(bell).toBeVisible();
    // Keyboard: the panel takes focus, Escape hands it back to the bell.
    await bell.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("dialog", { name: "Alerts" });
    await expect(panel).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(bell).toBeFocused();

    await bell.click();
    await panel.getByRole("button", { name: /SYN-001: 1 answer sent back/ }).click();
    await page.waitForURL(/\/review/);
    await expect(page.getByText("Sent back by Asha Patel:")).toBeVisible();
    await expect(questionHeading(page)).toHaveText(sentBack);
  });

  await test.step("activity: every step was recorded, newest first", async () => {
    const id = studyUrl.split("/").pop()!;
    // Paged by the API (`{ items, nextCursor }`); 100 is its page limit, plenty for one contract.
    const { items } = await (await request.get(`/api/v1/audit?studyId=${id}&limit=100`)).json();
    const actions: string[] = items.map((e: { action: string }) => e.action);
    expect(actions[0]).toBe("review.sent_back");
    for (const a of ["study.created", "study.confirmed", "extraction.completed", "review.answered", "values.proofread", "version.signed", "version.exported", "number.reported"]) expect(actions).toContain(a);
    expect(actions.filter((a) => a === "version.signed")).toHaveLength(1);
    await page.goto(`/audit?studyId=${id}`);
    await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  });

  expect(problems).toEqual([]);
});
