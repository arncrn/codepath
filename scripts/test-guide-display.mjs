import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject, allChanges } from "../tests/fixtures/git-project.mjs";
import { side } from "../tests/fixtures/authored-comparison.mjs";
import {
  waitViewed,
  chooseReviewFile,
  selectedReviewFile,
} from "./unified-review-check.mjs";
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
    file = list.files.find((file) => file.file === "part.ts"),
    view = await f.service.call("get_git_file", {
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
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.service.url + "?view=current-changes");
  const panel = page.locator("#current-changes"),
    source = selectedReviewFile(page),
    guide = page.locator(`[data-comparison-path="${saved.id}"]`);
  await panel.locator('.git-file-list[data-inventory-ready="true"]').waitFor();
  assert.equal(
    await panel.locator('.changed-file input[type="checkbox"]').count(),
    3
  );
  assert.equal(await panel.locator("[data-review-file]").count(), 3);
  await chooseReviewFile(page, "untracked", "other.ts");
  const listNode = await panel.locator(".git-file-list").elementHandle(),
    names = await panel
      .locator(".git-file-list .changed-file > button")
      .allTextContents();
  await guide.click();
  await panel.locator("[data-review-step-title]").first().waitFor();
  assert.equal(
    await source.locator(".review-file-heading h2").textContent(),
    "other.ts"
  );
  assert.ok((await guide.getAttribute("class")).includes("selected"));
  assert.equal(await source.locator(".guide-display").count(), 0);
  await chooseReviewFile(page, "unstaged", "part.ts");
  await source
    .locator("#git-comparisons h2")
    .filter({ hasText: saved.title })
    .waitFor();
  await source.locator(".current-columns pre").first().waitFor();
  assert.equal(
    await source.locator(".current-columns").count(),
    1,
    "One source display PER file, not an authored duplicate"
  );
  assert.equal(await source.locator("pre").count(), 2);
  assert.equal(
    await source
      .locator('[data-current-side="after"] code[data-source-line="2"]')
      .count(),
    1
  );
  assert.equal(await source.locator("details").count(), 0);
  assert.deepEqual(
    await panel
      .locator(".git-file-list .changed-file > button")
      .allTextContents(),
    names
  );
  const viewed = panel.getByLabel("Viewed untracked other.ts", { exact: true });
  await viewed.click();
  await waitViewed(page, "Viewed untracked other.ts", true);
  const after = source.locator('[data-current-side="after"]');
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Unsaved display draft");
  await guide.click();
  assert.equal(await source.locator(".guide-display").count(), 1);
  assert.equal(
    await source
      .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
      .count(),
    2
  );
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Unsaved display draft"
  );
  assert.equal(await source.locator(".optional-explanations").count(), 0);
  await guide.click();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Unsaved display draft"
  );
  await chooseReviewFile(page, "untracked", "other.ts");
  assert.ok((await guide.getAttribute("class")).includes("selected"));
  assert.equal(await source.locator(".guide-display").count(), 0);
  assert.equal(await viewed.isChecked(), true);
  await chooseReviewFile(page, "unstaged", "part.ts");
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Unsaved display draft",
    "File jumps do not retire another mounted file editor"
  );
  assert.equal(
    await listNode.evaluate(
      (old, now) => old === now,
      await panel.locator(".git-file-list").elementHandle()
    ),
    true
  );
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    stored
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS vertical inventory; one display per file, full raw fallback, exact explanations, persistent list/Viewed, independent unsaved draft and saved guide unchanged."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
