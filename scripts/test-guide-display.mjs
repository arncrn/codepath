import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject, allChanges } from "../tests/fixtures/git-project.mjs";
import { side } from "../tests/fixtures/authored-comparison.mjs";
import { waitViewed } from "./unified-review-check.mjs";

const cleanup = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  f.write(
    "other.ts",
    "// first full line\nconst other = 42;\n// final full line\n"
  );
  f.write("third.ts", "export const third = true;\n");
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Focused guide",
    listId: list.listId,
    steps: [
      {
        id: "amount",
        title: "Amount excerpt",
        fileId: file.id,
        binding: view.binding,
        before: side("Before amount", "Before purpose"),
        after: side("After amount", "After purpose"),
      },
    ],
  });
  const stored = await f.service.call("get_comparison_walkthrough", {
    id: saved.id,
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1550, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.service.url + "?view=current-changes");
  const panel = page.locator("#current-changes");
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  assert.equal(
    await panel.locator('.changed-file input[type="checkbox"]').count(),
    3
  );
  const open = (group, file) =>
    panel
      .getByRole("button", { name: `Open ${group} ${file}`, exact: true })
      .click();
  await open("untracked", "other.ts");
  await panel
    .locator('[data-current-side="after"] code[data-source-line="3"]')
    .waitFor();
  const listNode = await panel.locator(".git-file-list").elementHandle(),
    names = await panel
      .locator(".git-file-list .changed-file > button")
      .allTextContents();
  const guide = page.locator(`[data-comparison-path="${saved.id}"]`);
  await guide.click();
  await panel
    .locator(".current-diff-host > h2")
    .filter({ hasText: "other.ts" })
    .waitFor();
  assert.equal(
    await panel.locator(".current-diff-host > h2").textContent(),
    "other.ts"
  );
  assert.ok(
    (await guide.getAttribute("class")).includes("selected"),
    "Unmatched file keeps the enabled toggle and its normal full diff"
  );
  await open("unstaged", "part.ts");
  await panel
    .locator("#git-comparisons h2")
    .filter({ hasText: saved.title })
    .waitFor();
  await panel.locator(".current-columns pre").first().waitFor();
  assert.equal(
    await panel.locator(".current-columns").count(),
    1,
    "One current Git diff, independent of explanation scope"
  );
  assert.equal(await panel.locator("pre").count(), 2);
  assert.equal(
    await panel
      .locator('[data-current-side="after"] code[data-source-line="2"]')
      .count(),
    1
  );
  assert.equal(
    await panel.locator("details").count(),
    0,
    "No second display underneath"
  );
  assert.deepEqual(
    await panel
      .locator(".git-file-list .changed-file > button")
      .allTextContents(),
    names
  );
  const viewed = panel.getByLabel("Viewed untracked other.ts", { exact: true });
  await viewed.click();
  await waitViewed(page, "Viewed untracked other.ts", true);
  const after = panel.locator('[data-current-side="after"]');
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Unsaved display draft");
  await guide.click();
  await panel
    .locator('[data-current-side="after"] code[data-source-line="2"]')
    .waitFor();
  assert.equal(await panel.locator(".guide-display").count(), 1);
  assert.equal(
    await panel.getByRole("button", { name: "Notes", exact: true }).count(),
    2
  );
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Unsaved display draft"
  );
  assert.equal(await panel.locator(".optional-explanations").count(), 0);
  assert.equal(
    await panel
      .getByRole("heading", { name: "part.ts", exact: true })
      .textContent(),
    "part.ts"
  );
  await guide.click();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Unsaved display draft"
  );
  await open("untracked", "other.ts");
  await panel
    .locator('[data-current-side="after"] code[data-source-line="3"]')
    .waitFor();
  assert.ok((await guide.getAttribute("class")).includes("selected"));
  assert.equal(await panel.locator(".guide-display").count(), 0);
  assert.equal(await viewed.isChecked(), true);
  await open("unstaged", "part.ts");
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Unsaved display draft"
  );
  const now = await panel.locator(".git-file-list").elementHandle();
  assert.equal(await listNode.evaluate((old, now) => old === now, now), true);
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    stored
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS one display, selected-file excerpts/full fallback, persistent toggle and file-list DOM/manual Viewed, independent unsaved draft, saved guide unchanged."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
