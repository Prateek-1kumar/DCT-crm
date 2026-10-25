import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * The Phase 1 journey against the real API (EXTRACTION_FAKE=1 fakes only the AI) and the web in real-API mode.
 * Real contracts are used when present (git-ignored data/contracts; set DCT_ROOT when running from a worktree);
 * otherwise synthetic PDFs are printed by the browser.
 */

const CONTRACTS = path.join(process.env.DCT_ROOT ?? path.resolve(__dirname, ".."), "data/contracts");
// first two real PDFs by name (no contract names in the repo); real contracts can exceed Next's default 10 MB proxy body limit
const REAL = existsSync(CONTRACTS) ? readdirSync(CONTRACTS).filter((f) => f.endsWith(".pdf")).sort().slice(0, 2).map((f) => path.join(CONTRACTS, f)) : null;

type Pdf = { name: string; mimeType: string; buffer: Buffer };

async function printPdf(browser: Browser, name: string, pages: number): Promise<Pdf> {
  const p = await browser.newPage();
  await p.setContent(Array.from({ length: pages }, (_, i) => `<h1 style="page-break-after:always">${name} — page ${i + 1}</h1>`).join(""));
  const buffer = await p.pdf({ format: "Letter" });
  await p.close();
  return { name, mimeType: "application/pdf", buffer };
}

const realPdf = (file: string): Pdf => ({ name: path.basename(file), mimeType: "application/pdf", buffer: readFileSync(file) });

/** Console errors and failed API calls, checked at the end. Expected 4xx responses are listed by the test. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return problems;
}

async function actAs(page: Page, name: string) {
  await page.getByLabel("Acting as").selectOption(name);
}

test("bring on board → review → sign off → amend → sign v2 → audit → maker-checker", async ({ page, browser, request }, testInfo) => {
  const problems = watch(page);
  const docs = REAL ? REAL.map(realPdf) : [await printPdf(browser, "Work Order.pdf", 4), await printPdf(browser, "Budget.pdf", 3)];

  await test.step("settings: people", async () => {
    await page.goto("/settings");
    for (const n of ["Asha", "Ben"]) {
      await page.getByLabel("New person's name").fill(n);
      await page.getByRole("button", { name: "Add" }).click();
      await expect(page.getByRole("listitem").filter({ hasText: n })).toBeVisible();
    }
    await actAs(page, "Asha");
  });

  await test.step("upload 2 PDFs and a duplicate", async () => {
    await page.goto("/studies/new");
    const input = page.locator('input[type="file"]');
    await input.setInputFiles(docs);
    for (const d of docs) await expect(page.getByText(d.name, { exact: true })).toBeVisible({ timeout: 60_000 });
    await input.setInputFiles([{ ...docs[1]!, name: "copy of second.pdf" }]);
    // same sha256 as a file already in the list: skipped, not added twice
    await expect(page.getByText("Some files were already in this list and were skipped.")).toBeVisible();
    await expect(page.getByText("copy of second.pdf")).toHaveCount(0);
  });

  await test.step("identify and confirm", async () => {
    await page.getByRole("button", { name: /Identify 2 documents/ }).dblclick();
    await expect(page.getByLabel("Sponsor")).toHaveValue(/\S/, { timeout: 30_000 });
    expect(await (await request.get("/api/studies")).json()).toHaveLength(1); // the double-click made one study
    await page.reload(); // refresh on the confirm step resumes it
    await expect(page.getByLabel("Sponsor")).toHaveValue(/\S/);
    await expect(page.getByLabel("Principal investigator")).not.toHaveValue("");
    await page.getByRole("button", { name: /Confirm and start extraction/ }).click();
  });

  await test.step("extraction progress → review", async () => {
    await page.waitForURL(/\/extracting\?job=/);
    await page.waitForURL(/\/review\?v=1/, { timeout: 60_000 });
    await expect(page.getByRole("img", { name: /page 1/ })).toBeVisible();
    const img = page.getByRole("img", { name: /page 1/ });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(400);
  });
  const studyUrl = page.url().replace(/\/review\?.*$/, "");

  await test.step("clicking a value jumps to its page", async () => {
    await page.getByRole("region", { name: /Budget grid/ }).getByRole("button", { name: "$8,489.00" }).click();
    await expect(pageNumber(page)).toHaveValue("2");
    await expect(page.getByRole("img", { name: /page 2/ })).toBeVisible();
  });

  await test.step("inline edit: note required, text rejected in a money field", async () => {
    await page.getByRole("button", { name: "Edit Unscheduled visit Amount" }).click();
    const editor = page.locator("form").filter({ hasText: "· was $572.00" });
    await editor.getByRole("textbox").first().fill("abc");
    await editor.getByRole("button", { name: "Save correction" }).click();
    await expect(editor.getByText("Enter a dollar amount like 1,234.56")).toBeVisible();
    await editor.getByRole("textbox").first().fill("600");
    await editor.getByRole("button", { name: "Save correction" }).click();
    await expect(editor.getByText(/Add a note saying why/)).toBeVisible();
    await editor.getByLabel("Note (required)").fill("Exhibit B p.2 prints $600.00");
    await editor.getByRole("button", { name: "Save correction" }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("region", { name: /Invoiceables/ }).getByRole("button", { name: "$600.00" })).toBeVisible();
  });

  await test.step("refresh mid-review keeps the correction", async () => {
    await page.reload();
    await expect(page.getByRole("region", { name: /Invoiceables/ }).getByRole("button", { name: "$600.00" })).toBeVisible();
  });

  const signOff = page.getByRole("button", { name: "Sign off v1" });
  await test.step("sign-off is blocked while anomalies are open", async () => {
    await expect(signOff).toBeDisabled();
    await expect(page.getByText(/Sign-off is locked: 4 anomalies are not settled yet/)).toBeVisible();
  });

  await test.step("fix value (VISIT_TOTAL_MISMATCH)", async () => {
    const card = anomaly(page, "Visit total doesn't add up");
    await card.getByRole("button", { name: "Fix value" }).click();
    await card.getByRole("textbox").first().fill("8,488.00");
    await card.getByLabel("Note (required)").fill("Parts on p.2 add up to $8,488.00");
    await card.getByRole("button", { name: "Save and mark fixed" }).click();
    await expect(card.getByText("Fixed", { exact: true })).toBeVisible();
    await expect(card.getByRole("alert")).toHaveCount(0);
  });

  await test.step("choose reading (AI_DISAGREEMENT)", async () => {
    const card = anomaly(page, "The two AI reads disagree");
    await card.getByRole("button", { name: "Choose reading" }).click();
    await card.getByRole("button", { name: "Use this reading" }).click();
    await expect(card.getByText("Pick a reading and add a note.")).toBeVisible();
    await card.getByLabel(/OpenAI \(second read\)/).check();
    await card.getByLabel("Note (required)").fill("p.2 prints $801.00");
    await card.getByRole("button", { name: "Use this reading" }).click();
    await expect(card.getByText("Chosen", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: /Invoiceables/ }).getByRole("button", { name: "$801.00" })).toBeVisible();
  });

  await test.step("compare & choose grid (GRID_CONFLICT)", async () => {
    const card = anomaly(page, "Two budget grids conflict");
    await expect(card.getByRole("button", { name: "Fix value" })).toHaveCount(0);
    await card.getByRole("button", { name: "Compare & choose grid" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Exhibit A \(revised\)/).check();
    await dialog.getByLabel("Why this grid governs (required)").fill("Revised exhibit supersedes per sponsor email");
    await dialog.getByRole("button", { name: "Use Exhibit A (revised)" }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByText("Chosen", { exact: true })).toBeVisible();
  });

  await test.step("accept with note (MISSING_REFERENCED_DOC): empty note refused, double-click saves once", async () => {
    const card = anomaly(page, "Referenced document missing");
    await card.getByRole("button", { name: "Accept with note" }).click();
    await card.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(card.getByText("A note is required to accept.")).toBeVisible();
    await card.getByLabel("Note (required)").fill("Master CTA is on file with legal");
    await card.getByRole("button", { name: "Accept", exact: true }).dblclick();
    await expect(card.getByText("Accepted", { exact: true })).toBeVisible();
  });

  await test.step("sign off v1", async () => {
    await expect(page.getByText("4 of 4 anomalies settled")).toBeVisible();
    await expect(signOff).toBeEnabled();
    await signOff.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Signing as")).toHaveValue("Asha");
    await dialog.getByLabel("Note (optional)").fill("All four settled");
    await dialog.getByRole("button", { name: "Sign off and make live" }).dblclick();
    await page.waitForURL(/\?signed=1/);
    await expect(page.getByText("Version 1 signed off and live.")).toBeVisible();
    await expect(page.getByText("Live: v1")).toBeVisible();
  });

  await test.step("browser back to the signed review is read-only", async () => {
    await page.goBack();
    await expect(page.getByText(/Version 1 is signed — signed by Asha/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign off v1" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
    await page.goto(studyUrl);
  });

  await test.step("amendment upload (+ a duplicate of a stored file)", async () => {
    await page.getByRole("link", { name: "Upload amendment" }).click();
    const amendment = await printPdf(browser, "Amendment 1.pdf", 2);
    await page.locator('input[type="file"]').setInputFiles([amendment, { ...docs[0]!, name: "again.pdf" }]);
    await expect(page.getByText("Amendment 1.pdf")).toBeVisible();
    await expect(page.getByText("Duplicate: already uploaded")).toBeVisible();
    await page.getByLabel("Document kind for Amendment 1.pdf").selectOption("amendment");
    await expect(page.getByLabel("Document kind for Amendment 1.pdf")).toHaveValue("amendment");
    await page.getByRole("button", { name: "Extract amendment →" }).click();
    await page.waitForURL(/\/review\?v=2/, { timeout: 60_000 });
  });

  await test.step("diff-only review, v1 stays live", async () => {
    await expect(page.getByText("Amendment · diff vs live v1")).toBeVisible();
    await expect(page.getByText("Amendment in review")).toBeVisible();
    const inv = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Invoiceable/ }) });
    await expect(inv.getByText("Unscheduled visit › Amount with overhead")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Applies from/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Study" })).toHaveCount(0); // full rulebook hidden by default
    expect((await (await request.get(`/api${new URL(studyUrl).pathname}`)).json()).liveVersion).toBe(1);
  });

  await test.step("settle v2 and sign it; v1 is superseded", async () => {
    await settleAll(page);
    await page.getByRole("button", { name: "Sign off v2" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sign off and make live" }).click();
    await page.waitForURL(/\?signed=2/);
    await page.getByRole("tab", { name: /Versions & changes/ }).click();
    await expect(page.getByText("superseded").first()).toBeVisible();
    await expect(page.getByText("Live: v2")).toBeVisible();
  });

  await test.step("audit log shows everything, newest first", async () => {
    await page.getByRole("link", { name: "Audit log" }).last().click();
    await page.waitForURL(/\/audit\?studyId=/);
    const entries = await (await request.get(`/api/audit?studyId=${new URL(studyUrl).pathname.split("/").pop()}`)).json();
    const actions: string[] = entries.map((e: { action: string }) => e.action);
    expect(actions[0]).toBe("version.signed");
    for (const a of ["study.created", "study.identified", "study.confirmed", "extraction.queued", "extraction.completed", "value.corrected", "anomaly.resolved", "grid.chosen", "version.signed"])
      expect(actions).toContain(a);
    // double-clicks didn't record anything twice
    expect(actions.filter((a) => a === "version.signed")).toHaveLength(2);
    expect(entries.filter((e: { action: string; detail: { code?: string; version?: number } }) => e.action === "anomaly.resolved" && e.detail.code === "MISSING_REFERENCED_DOC" && e.detail.version === 1)).toHaveLength(1);
    await expect(page.getByText("value.corrected").or(page.getByText(/corrected/i)).first()).toBeVisible();
  });

  await test.step("page image URL: wrong page numbers are 404s", async () => {
    const study = await (await request.get(`/api${new URL(studyUrl).pathname}`)).json();
    const doc = study.documents[0];
    for (const n of [0, doc.pageCount + 1, 9999]) expect((await request.get(`/api/documents/${doc.id}/pages/${n}.png`)).status()).toBe(404);
    expect((await request.get(`/api/documents/${doc.id}/pages/abc.png`)).status()).toBe(404);
    expect((await request.get(`/api/documents/not-a-uuid/pages/1.png`)).status()).toBe(400);
    expect((await request.get(`/api/documents/${doc.id}/pages/${doc.pageCount}.png`)).status()).toBe(200);
  });

  await test.step("non-PDF rejected in the browser and by the API", async () => {
    await page.goto("/studies/new");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
      { name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("not really a pdf") },
    ]);
    await expect(page.getByText(/Skipped: notes.txt \(not a PDF\)/)).toBeVisible();
    await expect(page.getByText("fake.pdf is not a PDF")).toBeVisible();
    const huge = testInfo.outputPath("huge.pdf");
    writeFileSync(huge, Buffer.alloc(51 * 1024 * 1024));
    await page.locator('input[type="file"]').setInputFiles(huge);
    await expect(page.getByText(/Skipped: huge.pdf \(over 50 MB\)/)).toBeVisible();
  });

  await test.step("failed amendment extraction: study page offers retry / manual entry seeded from live", async () => {
    await page.goto(`${studyUrl}/amend`);
    await page.locator('input[type="file"]').setInputFiles([await printPdf(browser, "unreadable amendment 2.pdf", 1)]);
    await page.getByRole("button", { name: "Extract amendment →" }).click();
    await expect(page.getByText("Extraction failed")).toBeVisible({ timeout: 30_000 });
    await page.goto(studyUrl);
    await expect(page.getByText("Amendment in review")).toBeVisible();
    await expect(page.getByText("The last extraction failed.")).toBeVisible();
    await page.getByRole("button", { name: "Enter manually" }).click();
    await page.waitForURL(/\/review\?v=3/);
    await expect(page.getByText("Amendment · diff vs live v2")).toBeVisible();
    await expect(page.getByText("Unscheduled visit › Amount with overhead")).toHaveCount(0); // seeded from v2: unchanged terms aren't in the diff
    await expect(page.getByRole("heading", { name: /^Applies from/ })).toBeVisible(); // must be entered for the amendment
  });

  await test.step("failed extraction → enter manually; maker-checker blocks the editor", async () => {
    await page.goto("/settings");
    await page.getByRole("switch", { name: "Maker-checker" }).click();
    await expect(page.getByText("On: corrector and signer must be different people.")).toBeVisible();

    await page.goto("/studies/new");
    await page.locator('input[type="file"]').setInputFiles([await printPdf(browser, "unreadable scan.pdf", 2)]);
    await page.getByRole("button", { name: /Identify 1 document/ }).click();
    await page.getByRole("button", { name: /Confirm and start extraction/ }).click();
    await expect(page.getByText("Extraction failed")).toBeVisible({ timeout: 30_000 });
    await page.reload(); // refresh on the failed job keeps the choices
    await page.getByRole("button", { name: "Enter manually" }).dblclick();
    await page.waitForURL(/\/review\?v=1/);
    await expect(page.getByText("Manual").first()).toBeVisible();

    await page.getByRole("button", { name: "Edit Net days", exact: true }).click();
    const editor = page.locator("form").filter({ hasText: "· was" });
    await editor.locator("input").first().fill("45");
    await editor.getByLabel("Note (required)").fill("p.1 says net 45");
    await editor.getByRole("button", { name: "Save correction" }).click();
    await expect(page.getByText(/corrected by Asha/)).toBeVisible();
    await settleAll(page);

    await expect(page.getByRole("button", { name: "Sign off v1" })).toBeDisabled();
    await expect(page.getByText(/maker-checker/i).first()).toBeVisible();
    await actAs(page, "Ben");
    await page.getByRole("button", { name: "Sign off v1" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sign off and make live" }).click();
    await page.waitForURL(/\?signed=1/);
  });

  expect(problems).toEqual([]);
});

const pageNumber = (page: Page) => page.getByRole("spinbutton", { name: /Page number/ });
const anomaly = (page: Page, title: string) => page.getByRole("region", { name: "Anomalies" }).getByRole("listitem").filter({ hasText: title });

/** Accept every open anomaly with a note. */
async function settleAll(page: Page) {
  const panel = page.getByRole("region", { name: "Anomalies" });
  for (;;) {
    const open = panel.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Accept with note" }) });
    if (!(await open.count())) break;
    // pin the card by its message: once opened it no longer has the "Accept with note" button
    const card = panel.getByRole("listitem").filter({ hasText: (await open.first().locator("p").nth(1).textContent())! });
    await card.getByRole("button", { name: "Accept with note" }).click();
    await card.getByLabel("Note (required)").fill("Checked against the contract");
    await card.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(card.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  }
}
