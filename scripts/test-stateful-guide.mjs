import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture } from "../tests/fixtures/authored-comparison.mjs";
import {
  waitViewed,
  selectedReviewFile,
  chooseReviewFile,
} from "./unified-review-check.mjs";
import { verifyReviewNavigation } from "./check-review-navigation.mjs";

const cleanup = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser, release;
try {
  const { saved } = await authorFixture(f);
  f.write("other.ts", "// full beginning\nconst other = 42;\n// full ending\n");
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
      if (!/^(get_|list_|check_)/.test(name)) writes.push(name);
    }
  });
  await page.goto(f.service.url + "?view=current-changes");
  const panel = page.locator("#current-changes"),
    guide = page.locator(`[data-comparison-path="${saved.id}"]`),
    source = selectedReviewFile(page),
    after = source.locator('[data-current-side="after"]');
  const select = (group, file) => chooseReviewFile(page, group, file);
  const enabled = async (value) =>
    assert.equal(
      (await guide.getAttribute("class")).includes("selected"),
      value,
      "Only explicit toggle clicks may change guide enabled state"
    );
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  await select("staged", "part.ts");
  await guide.click();
  await after
    .getByRole("heading", { name: "Staged amount", exact: true })
    .waitFor();
  const list = await panel.locator(".git-file-list").elementHandle(),
    names = await panel
      .locator(".git-file-list .changed-file > button")
      .allTextContents();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Independent staged draft");
  await select("unstaged", "part.ts");
  await enabled(true);
  await after
    .getByRole("heading", { name: "Expanded saved calculation", exact: true })
    .waitFor();
  assert.equal(
    await after.locator('code[data-source-line="1"]').innerText(),
    "const amount = 3;"
  );
  assert.equal(await source.locator("pre").count(), 2);
  assert.equal(await source.locator(".current-columns").count(), 1);
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Independent unstaged draft");
  await verifyReviewNavigation(page);
  await select("untracked", "other.ts");
  await enabled(true);
  await source
    .locator(".review-file-heading h2")
    .filter({ hasText: "other.ts" })
    .waitFor();
  assert.equal(
    await source
      .locator('[data-current-side="after"] code[data-source-line]')
      .count(),
    3
  );
  assert.equal(await source.locator(".guide-display").count(), 0);
  assert.equal(
    await source.locator(".current-columns .authored-purpose").count(),
    0
  );
  assert.equal(await source.locator("pre").count(), 2);
  const viewed = panel.getByLabel("Viewed untracked other.ts", { exact: true });
  await viewed.click();
  await waitViewed(page, "Viewed untracked other.ts", true);
  await select("staged", "part.ts");
  await enabled(true);
  await after
    .getByRole("heading", { name: "Staged amount", exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Independent staged draft"
  );
  await guide.click();
  await enabled(false);
  await source
    .locator('[data-current-side="after"] code[data-source-line="2"]')
    .waitFor();
  await select("unstaged", "part.ts");
  await enabled(false);
  await source
    .locator('[data-current-side="after"] code[data-source-line="4"]')
    .waitFor();
  assert.equal(await source.locator(".guide-display").count(), 1);
  assert.equal(
    await source
      .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
      .count(),
    2
  );
  assert.equal(await source.locator(".optional-explanations").count(), 0);
  await guide.click();
  await enabled(true);
  await after
    .getByRole("heading", { name: "Expanded saved calculation", exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Independent unstaged draft"
  );
  await after.getByLabel("Note text").fill("Accepted old file ACK");
  let announce;
  const seen = new Promise((resolve) => (announce = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  let held = false;
  await page.route("**/api/call", async (route) => {
    const p = route.request().postDataJSON();
    if (
      !held &&
      p.name === "save_walkthrough_comparison_note" &&
      p.arguments.body === "Accepted old file ACK"
    ) {
      held = true;
      const response = await route.fetch();
      announce();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await after.getByRole("button", { name: "Save note", exact: true }).click();
  await seen;
  await select("untracked", "other.ts");
  await source
    .locator(".review-file-heading h2")
    .filter({ hasText: "other.ts" })
    .waitFor();
  await select("unstaged", "part.ts");
  await after
    .getByRole("heading", { name: "Expanded saved calculation", exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("New file lifetime draft");
  const ack = page.waitForResponse(
    (response) =>
      response.request().postDataJSON()?.arguments?.body ===
      "Accepted old file ACK"
  );
  release();
  await ack;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve)
        )
      )
  );
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "New file lifetime draft"
  );
  assert.equal(
    await after
      .getByRole("button", { name: "Save note", exact: true })
      .isEnabled(),
    true
  );
  await enabled(true);
  assert.equal(await viewed.isChecked(), true);
  await verifyReviewNavigation(page);
  assert.deepEqual(
    await panel
      .locator(".git-file-list .changed-file > button")
      .allTextContents(),
    names
  );
  const currentList = await panel.locator(".git-file-list").elementHandle();
  assert.equal(
    await list.evaluate((old, now) => old === now, currentList),
    true
  );
  const final = await f.service.call("get_comparison_walkthrough", {
    id: saved.id,
  });
  assert.deepEqual(
    final.steps.map(({ annotations: _annotations, ...step }) => step),
    saved.steps.map(({ annotations: _annotations, ...step }) => step)
  );
  for (const step of saved.steps)
    for (const note of step.annotations.notes)
      assert.ok(
        final.steps
          .find((s) => s.id === step.id)
          .annotations.notes.some((n) => n.id === note.id)
      );
  assert.ok(
    final.steps
      .find((step) => step.id === "expanded")
      .annotations.notes.some((note) => note.body === "Accepted old file ACK")
  );
  assert.deepEqual(writes, [
    "set_git_viewed",
    "save_walkthrough_comparison_note",
  ]);
  await page
    .getByRole("button", { name: "Hide navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.equal(
    await page.locator("aside").isVisible(),
    true,
    "Walkthrough navigation is restored outside review"
  );
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .waitFor();
  assert.equal(
    await page.locator("aside").isVisible(),
    false,
    "Review keeps its local width preference when revisited"
  );
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  assert.equal(await page.locator("aside").isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS persistent on/off file navigation; staged/unstaged same-path excerpts follow exact file/group; unmatched file full-diff fallback; one code display, list/Viewed/drafts/source IDs preserved; held old file ACK cannot clear new editor."
  );
} finally {
  release?.();
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
