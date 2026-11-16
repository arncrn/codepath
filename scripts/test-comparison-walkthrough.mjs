/* global document, getSelection, MouseEvent -- Browser source selection. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture } from "../tests/fixtures/authored-comparison.mjs";
import {
  readReviewStep,
  selectedReviewFile,
  assertParallel,
} from "./unified-review-check.mjs";
import { verifyComposedReview } from "./composed-review-check.mjs";
const cleanup = [],
  f = await gitProject({ after: (c) => cleanup.push(c) });
let browser;
try {
  const { saved } = await authorFixture(f);
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
      viewport: { width: 1550, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.service.url + "?view=changes");
  const panel = page.locator("#current-changes"),
    source = selectedReviewFile(page),
    before = source.locator('[data-current-side="before"]'),
    after = source.locator('[data-current-side="after"]');
  await panel.locator("[data-review-step-title]").first().waitFor();
  assert.equal(await panel.locator("nav.comparison-steps").count(), 0);
  await panel.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  assert.equal(await panel.locator(".changed-file input").count(), 3);
  await readReviewStep(page, "Choose the amount");
  await panel
    .getByRole("checkbox", { name: "Show only changed sections", exact: true })
    .uncheck();
  await before
    .getByText("Begin with the committed value.", { exact: true })
    .waitFor();
  await after
    .getByText("Use the explicitly staged value.", { exact: true })
    .waitFor();
  assert.match(
    await before.locator(".current-file-card > header").innerText(),
    /HEAD|committed/i
  );
  assert.match(
    await after.locator(".current-file-card > header").innerText(),
    /Index|staged/i
  );
  assert.equal(
    await before.locator("code[data-source-line]").count(),
    2,
    "Full current context stays visible outside the authored first line"
  );
  assert.equal(await source.locator("pre").count(), 2);
  await assertParallel(page, source.locator(".current-columns"));
  await before
    .locator(".source-attachment")
    .first()
    .evaluate((element) => {
      const r = document.createRange();
      r.selectNodeContents(element);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      element
        .closest("code")
        .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await before
    .getByRole("button", { name: "Explain selected variable", exact: true })
    .click();
  await before
    .getByLabel("Note text")
    .fill("Human before variable explanation");
  await before.getByLabel("Variable name").fill("mount");
  await before.getByRole("button", { name: "Save note", exact: true }).click();
  await before
    .getByRole("alert")
    .filter({ hasText: /whole identifier/i })
    .waitFor();
  assert.equal(
    await before.getByLabel("Note text").inputValue(),
    "Human before variable explanation"
  );
  await before.getByLabel("Variable name").fill("amount");
  await before.getByRole("button", { name: "Save note", exact: true }).click();
  await before
    .locator(".review-notes")
    .getByText("Human before variable explanation", { exact: true })
    .waitFor();
  const persisted = await f.service.call("get_comparison_walkthrough", {
      id: saved.id,
    }),
    human = persisted.steps[0].annotations.notes.find(
      (n) => n.body === "Human before variable explanation"
    );
  assert.equal(human.side, "before");
  assert.equal(human.variableName, "amount");
  assert.equal(human.attachments[0].text, "amount");
  await readReviewStep(page, "Expand the calculation");
  await after
    .getByRole("heading", { name: "Expanded saved calculation", exact: true })
    .waitFor();
  assert.equal(await before.locator("code[data-source-line]").count(), 2);
  assert.equal(await after.locator("code[data-source-line]").count(), 4);
  assert.equal(
    await before.locator(".diff-removed").count(),
    2,
    "Full current source retains the second removed line outside the authored range"
  );
  assert.ok((await after.locator(".diff-added").count()) >= 2);
  const marker = after.locator("[data-block-note-id]").first();
  assert.equal(
    await marker.evaluate(
      (e) => globalThis.getComputedStyle(e).backgroundColor
    ),
    await after
      .locator(".block-note")
      .first()
      .evaluate((e) => globalThis.getComputedStyle(e).borderLeftColor)
  );
  await after
    .getByRole("button", { name: /^Variables(?: · \d+)?$/, exact: true })
    .click();
  await after
    .getByText("Expanded saved calculation named amount", { exact: true })
    .waitFor();
  assert.equal(await source.locator("[data-reference]").count(), 0);
  await after.locator(".source-attachment").first().focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#modal:visible").count(), 0);
  await assertParallel(page, source.locator(".current-columns"));
  await readReviewStep(page, "Introduce saved context");
  await after
    .getByRole("heading", { name: "Introduced context", exact: true })
    .waitFor();
  assert.equal(await after.locator("code[data-source-line]").count(), 35);
  assert.ok(
    (await after.locator(".review-source").boundingBox()).height > 600,
    "Do not cap a full long source"
  );
  assert.equal(await before.locator("code[data-source-line]").count(), 0);
  await before
    .getByText("There is no earlier source block.", { exact: false })
    .waitFor();
  assert.equal(
    await panel
      .getByRole("button", { name: "Read saved guide source", exact: true })
      .count(),
    0
  );
  const resources = [];
  page.on("request", (r) => {
    if (r.url().includes("invalid.example/comparison")) resources.push(r.url());
  });
  await verifyComposedReview(page, f);
  assert.deepEqual(resources, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS one inline review: full current paired sources, exact Variable validation/attachment/palette, scoped Notes, parallel geometry/zoom, absent/long source, safe Markdown/function context/history and independent drafts."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
