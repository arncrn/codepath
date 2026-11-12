/* global getComputedStyle -- Chrome DOM callbacks. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { gitProject, allChanges } from "../tests/fixtures/git-project.mjs";
import { side } from "../tests/fixtures/authored-comparison.mjs";
import { readSavedStep } from "./unified-review-check.mjs";

const cleanup = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Repeated authored ranges",
    listId: list.listId,
    steps: ["first", "second"].map((id) => ({
      id,
      title: "Step " + id,
      fileId: file.id,
      binding: view.binding,
      before: side("Before " + id, "Purpose before " + id),
      after: side("After " + id, "Purpose after " + id),
    })),
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1550, height: 1000 },
  });
  const errors = [],
    writes = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().endsWith("/api/call")) {
      const { name } = request.postDataJSON();
      if (!/^(get|list|check)_/.test(name)) writes.push(name);
    }
  });
  await page.goto(f.service.url + "?view=current-changes");
  const panel = page.locator("#current-changes"),
    guide = page.locator(`[data-comparison-path="${saved.id}"]`);
  await panel.locator(".current-columns pre").first().waitFor();
  await guide.click();
  await readSavedStep(page, "Step first");
  const after = panel.locator('[data-git-side="after"]');
  assert.equal(await panel.locator("pre").count(), 2);
  assert.equal(await panel.locator(".current-columns").count(), 0);
  assert.equal(
    await panel
      .locator('.comparison-steps [aria-current="step"]')
      .getAttribute("aria-label"),
    "Step first",
    "Authored step identity, never inferred file/order pairing"
  );
  const marker = after.locator("[data-block-note-id]").first(),
    note = after.locator(".block-note").first();
  assert.equal(
    await marker.evaluate((e) => getComputedStyle(e).backgroundColor),
    await note.evaluate((e) => getComputedStyle(e).borderLeftColor)
  );
  await after.getByRole("button", { name: "Variables", exact: true }).click();
  assert.equal(await after.locator(".source-attachment").count(), 1);
  assert.equal(
    await after
      .locator(".source-attachment")
      .first()
      .evaluate((e) => getComputedStyle(e).textDecorationColor),
    await after
      .locator(".note")
      .first()
      .evaluate((e) => getComputedStyle(e).borderLeftColor)
  );
  assert.equal(
    await after.locator('code[data-source-line="2"]').count(),
    0,
    "Outside-range full-file context is not displayed/attachable in guide mode"
  );
  await after
    .getByRole("button", { name: "Write variable explanation", exact: true })
    .click();
  await after.getByLabel("Note text").fill("Independent first draft");
  await readSavedStep(page, "Step second");
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Independent second draft");
  await readSavedStep(page, "Step first");
  await after.getByRole("button", { name: "Variables", exact: true }).click();
  await after
    .getByRole("button", { name: "Write variable explanation", exact: true })
    .click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Independent first draft"
  );
  // Changed working bytes do not relabel/rebind the immutable guide as current.
  f.write("part.ts", "const amount = 99;\nunchanged\n");
  await panel
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  await panel
    .getByRole("button", { name: "Back to current diff", exact: true })
    .waitFor();
  assert.equal(
    await after.locator('code[data-source-line="1"]').innerText(),
    "const amount = 2;"
  );
  assert.equal(await panel.locator("pre").count(), 2);
  await guide.click();
  await panel
    .locator('[data-current-side="after"] code[data-source-line="1"]')
    .filter({ hasText: "99" })
    .waitFor();
  assert.equal(await panel.locator(".guide-display").count(), 1);
  assert.equal(
    await panel.getByRole("button", { name: "Notes", exact: true }).count(),
    0,
    "Source mismatch refuses annotations in full-file mode too"
  );
  assert.equal(
    await panel.locator(".current-columns .source-attachment").count(),
    0
  );
  assert.equal(
    await panel.locator(".current-columns .authored-purpose").count(),
    0
  );
  await guide.click();
  await readSavedStep(page, "Step first");
  assert.equal(
    await after.locator('code[data-source-line="1"]').innerText(),
    "const amount = 2;"
  );
  assert.equal(
    await panel.getByLabel("Viewed unstaged part.ts").isChecked(),
    false
  );
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  const bytes = fs.readFileSync(path.join(f.root, ".codepaths/workspace.json"));
  await panel.getByRole("button", { name: "Compare", exact: true }).click();
  await panel.getByText(/different comparison choices/).waitFor();
  assert.equal(await panel.locator(".current-columns").count(), 0);
  assert.equal(
    await after.locator('code[data-source-line="1"]').innerText(),
    "const amount = 2;"
  );
  fs.renameSync(
    path.join(f.root, ".git"),
    path.join(f.root, "owned-git-hidden")
  );
  try {
    await page.reload();
    await guide.click();
    await readSavedStep(page, "Step first");
    assert.equal(
      await after.locator('code[data-source-line="1"]').innerText(),
      "const amount = 2;"
    );
    assert.equal(await panel.locator(".current-columns").count(), 0);
    assert.deepEqual(
      fs.readFileSync(path.join(f.root, ".codepaths/workspace.json")),
      bytes
    );
  } finally {
    fs.renameSync(
      path.join(f.root, "owned-git-hidden"),
      path.join(f.root, ".git")
    );
  }
  assert.deepEqual(
    writes,
    [],
    "All display/source navigation is read-only; no Viewed credit or re-review"
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS explicit step IDs, focused attachment bounds/palette/independent drafts; source/query changes and missing Git preserve honestly labeled saved excerpts, restore unannotated current bytes on deselection, no writes/Viewed credit/rebinding."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
