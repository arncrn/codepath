/* global document, getSelection, getComputedStyle, MouseEvent -- Chrome DOM callbacks. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { gitProject, allChanges } from "../tests/fixtures/git-project.mjs";
import { authorFixture } from "../tests/fixtures/authored-comparison.mjs";
import { verifyComposedReview } from "./composed-review-check.mjs";
import {
  assertParallel,
  readSavedStep,
  chooseReviewFile,
} from "./unified-review-check.mjs";

const cleanup = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  const { saved } = await authorFixture(f);
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1550, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.service.url + "?view=changes");
  const panel = page.locator("#current-changes");
  await panel
    .getByRole("heading", { name: "Amount evolution", exact: true })
    .waitFor();
  await page.locator(`[data-comparison-path="${saved.id}"]`).waitFor();
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  assert.equal(
    await panel.locator(".git-file-list").count(),
    1,
    "Guide keeps the complete live inventory"
  );
  assert.equal(
    await panel
      .locator('.git-file-list .changed-file input[type="checkbox"]')
      .count(),
    3
  );
  const before = panel.locator('[data-git-side="before"]'),
    after = panel.locator('[data-git-side="after"]');
  await readSavedStep(page, "Choose the amount");
  await before
    .getByText("Begin with the committed value.", { exact: true })
    .waitFor();
  await after
    .getByText("Use the explicitly staged value.", { exact: true })
    .waitFor();
  assert.match(
    await before.locator(".comparison-card-heading").innerText(),
    /HEAD|committed/i
  );
  assert.match(
    await after.locator(".comparison-card-heading").innerText(),
    /Index|staged/i
  );
  assert.equal(
    await before.locator("code[data-source-line]").count(),
    1,
    "Focused authored range replaces full raw source"
  );
  assert.equal(await after.locator("code[data-source-line]").count(), 1);
  assert.equal(await panel.locator("pre").count(), 2);
  await assertParallel(page, panel.locator(".walkthrough-columns"));
  // Before selection is exact and Variables are independently attached.
  await before
    .locator(".source-attachment")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
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
  });
  const human = persisted.steps[0].annotations.notes.find(
    (note) => note.body === "Human before variable explanation"
  );
  assert.equal(human.side, "before");
  assert.equal(human.variableName, "amount");
  assert.equal(human.attachments[0].text, "amount");
  await readSavedStep(page, "Expand the calculation");
  await after
    .getByRole("heading", { name: "Expanded saved calculation", exact: true })
    .waitFor();
  assert.equal(await before.locator("code[data-source-line]").count(), 1);
  assert.equal(await after.locator("code[data-source-line]").count(), 4);
  assert.equal(await before.locator(".diff-removed").count(), 1);
  assert.ok((await after.locator(".diff-added").count()) >= 2);
  const marker = after.locator("[data-block-note-id]").first();
  assert.equal(
    await marker.evaluate((e) => getComputedStyle(e).backgroundColor),
    await after
      .locator(".block-note")
      .first()
      .evaluate((e) => getComputedStyle(e).borderLeftColor)
  );
  await after.getByRole("button", { name: "Variables", exact: true }).click();
  await after
    .getByText("Expanded saved calculation named amount", { exact: true })
    .waitFor();
  assert.equal(
    await after
      .locator(".source-attachment")
      .first()
      .evaluate((e) => getComputedStyle(e).textDecorationColor),
    await after
      .locator(".note")
      .filter({ hasText: "Expanded saved calculation named amount" })
      .evaluate((e) => getComputedStyle(e).borderLeftColor)
  );
  assert.equal(await panel.locator("[data-reference]").count(), 0);
  await after.locator(".source-attachment").first().focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowRight");
  assert.equal(
    await panel
      .locator('.comparison-steps [aria-current="step"]')
      .getAttribute("aria-label"),
    "Expand the calculation"
  );
  assert.equal(await page.locator("#modal:visible").count(), 0);
  await panel
    .getByRole("navigation", { name: "Paired walkthrough steps" })
    .getByRole("button", { name: "Expand the calculation", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.locator("#new-path").click();
  await page.locator("#close-modal").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await panel
      .locator('.comparison-steps [aria-current="step"]')
      .getAttribute("aria-label"),
    "Expand the calculation"
  );
  await page.locator("#close-modal").click();
  for (const column of [before, after])
    assert.ok(
      (await column.locator(".review-source").boundingBox()).y <
        (await column.locator(".authored-purpose").boundingBox()).y
    );
  await assertParallel(page, panel.locator(".walkthrough-columns"));
  const output = path.resolve(
    process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/comparison-walkthrough"
  );
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "unified-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 760, height: 900 });
  assert.ok(
    await panel
      .locator(".comparison-scroll")
      .first()
      .evaluate((e) => e.scrollWidth > e.clientWidth)
  );
  await page.screenshot({
    path: path.join(output, "unified-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1550, height: 1000 });
  await readSavedStep(page, "Introduce saved context");
  await after
    .getByRole("heading", { name: "Introduced context", exact: true })
    .waitFor();
  assert.equal(await after.locator("code[data-source-line]").count(), 35);
  assert.ok(
    (await after.locator(".review-source").boundingBox()).height > 600,
    "No capped long-source pane"
  );
  assert.equal(await before.locator("code[data-source-line]").count(), 0);
  await before
    .getByText("There is no earlier source block.", { exact: false })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "unified-long-source.png"),
    fullPage: true,
  });
  // Distinguish genuinely absent, present-empty and an explicitly selected blank line.
  f.write("blank.ts", "\n");
  f.write("empty.ts", "");
  const emptyList = await allChanges(f.service),
    steps = [];
  for (const [fileName, id] of [
    ["blank.ts", "blank"],
    ["empty.ts", "empty"],
  ]) {
    const file = emptyList.files.find((file) => file.file === fileName),
      source = await f.service.call("get_git_file", {
        listId: emptyList.listId,
        fileId: file.id,
      });
    const emptySide = (title, line) => ({
      title,
      purpose: "A long word wraps: " + "readable".repeat(200),
      startLine: line,
      endLine: line,
      notes: [],
      variables: [],
      notApplicable: {
        notes: "No nonblank source blocks.",
        variables: "No identifiers.",
      },
    });
    steps.push({
      id,
      title: id,
      fileId: file.id,
      binding: source.binding,
      before: emptySide("Absent earlier", 0),
      after: emptySide(
        id === "blank" ? "Selected blank line" : "Present empty file",
        id === "blank" ? 1 : 0
      ),
    });
  }
  const empties = await f.service.call("create_comparison_walkthrough", {
    title: "Empty-side distinctions",
    listId: emptyList.listId,
    steps,
  });
  await f.service.call("save_walkthrough_comparison_note", {
    walkthroughId: empties.id,
    stepId: "empty",
    side: "after",
    binding: empties.steps[1].binding,
    expectedRevision: empties.steps[1].annotations.revision,
    body: "unbroken".repeat(500),
    author: "Human",
    attachments: [],
  });
  await page.reload();
  await chooseReviewFile(page, "untracked", "blank.ts");
  await page.locator(`[data-comparison-path="${empties.id}"]`).click();
  for (const id of ["blank", "empty"]) {
    await readSavedStep(page, id);
    await after
      .getByRole("heading", {
        name: id === "blank" ? "Selected blank line" : "Present empty file",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await before.getByText("No file on this side.", { exact: true }).count(),
      1
    );
    if (id === "empty")
      assert.equal(
        await after
          .getByText("Empty file on this side.", { exact: true })
          .count(),
        1
      );
    const historical = await readSavedStep(page, id);
    assert.equal(
      await historical
        .getByText("No file on this side.", { exact: true })
        .count(),
      1
    );
    assert.equal(
      await historical
        .getByText(
          id === "blank" ? "Blank source excerpt." : "Empty file on this side.",
          { exact: true }
        )
        .count(),
      1
    );
    for (const zoom of [1, 1.25, 2]) {
      await page.setViewportSize({ width: 760, height: 1000 });
      await page.locator("body").evaluate((e, z) => {
        e.style.zoom = String(z);
      }, zoom);
      assert.equal(
        await panel
          .locator(".authored-purpose p, .review-notes p")
          .evaluateAll((elements) =>
            elements.every((e) => e.scrollWidth <= e.clientWidth + 1)
          ),
        true,
        "Long purpose/note words wrap at narrow zoom"
      );
    }
    await page.locator("body").evaluate((e) => {
      e.style.zoom = "1";
    });
    await page.setViewportSize({ width: 1550, height: 1000 });
  }
  const resources = [];
  page.on("request", (request) => {
    if (request.url().includes("invalid.example/comparison"))
      resources.push(request.url());
  });
  await verifyComposedReview(page, f);
  assert.deepEqual(resources, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS Chrome unified/full-source and explicit saved excerpts: staged/unstaged/untracked, independent content/attachments/palette, exact variable edits, geometry/zoom, no popups/native gestures, empty/blank source, composed Markdown/context."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
