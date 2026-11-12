import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture, side } from "../tests/fixtures/authored-comparison.mjs";
import { readSavedStep } from "./unified-review-check.mjs";

const cleanup = [];
const f = await gitProject({ after: (fn) => cleanup.push(fn) });
let browser;
const gates = [];
try {
  const { saved, list, first } = await authorFixture(f);
  const other = await f.service.call("create_comparison_walkthrough", {
    title: "Other authored view",
    listId: list.listId,
    steps: [
      {
        id: "other",
        title: "Other purpose",
        fileId: first.file.id,
        binding: first.binding,
        before: side("Other original", "A separately authored before purpose."),
        after: side("Other staged", "A separately authored after purpose."),
      },
    ],
  });
  const walk = await f.service.call("save_walkthrough", {
    title: "Ordinary",
    steps: [
      {
        id: "live",
        title: "Live",
        source: { file: "part.ts", startLine: 1, endLine: 1 },
        explanation: "Ordinary card purpose",
      },
    ],
  });
  await f.service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "live",
    body: "Delete ordinary",
    author: "Human",
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.service.url);
  await page.locator('.code-card[data-step="live"]').waitFor();
  await page.locator("#notes-tab").click();
  await page.locator("#note-text").fill("Keep ordinary draft");
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  const panel = page.locator("#current-changes");
  await readSavedStep(page, "Choose the amount");
  const after = panel.locator('[data-git-side="after"]');
  await after
    .getByRole("heading", { name: "Staged amount", exact: true })
    .waitFor();
  for (const forbidden of [
    "Review identity",
    "Captured review",
    "Capture review",
    "Check live status",
    "Snapshot provenance",
    "Live source matches",
    "Review JSON",
    "Repair source reference",
  ])
    assert.ok(!(await panel.innerText()).includes(forbidden), forbidden);
  assert.equal(
    await after
      .locator(".diff-added")
      .first()
      .evaluate((e) => globalThis.getComputedStyle(e).backgroundColor),
    "rgb(25, 63, 43)"
  );
  const button = (scope, name) =>
    scope.getByRole("button", { name, exact: true });
  await button(after, "Write note").click();
  await after.getByLabel("Note text").fill("Human comparison note");
  await readSavedStep(page, "Choose the amount");
  await readSavedStep(page, "Choose the amount");
  await button(after, "Save note").click();
  const human = () =>
    after
      .locator(".review-notes .note")
      .filter({ hasText: "Human comparison note" });
  await human().waitFor();
  await button(human(), "Edit").click();
  await after.getByLabel("Note text").fill("Corrected annotation");
  await button(after, "Save note").click();
  await after.getByText("Corrected annotation", { exact: true }).waitFor();
  await button(after, "Write note").click();
  await after.getByLabel("Note text").fill("Independent comparison draft");
  // The sole live comparison controls really select the current comparison.
  const choices = panel.locator(".current-source-choices");
  await button(choices, "Compare").click();
  await choices
    .getByLabel("Current base branch")
    .selectOption("refs/heads/main");
  await choices
    .getByLabel("Current target", { exact: true })
    .selectOption("refs/heads/equal");
  await panel
    .getByText("No allowed-path differences.", { exact: true })
    .waitFor();
  const historical = await readSavedStep(page, "Choose the amount");
  assert.equal(
    await historical
      .locator('[data-git-side="after"] code[data-source-line]')
      .innerText(),
    "const amount = 2;"
  );
  assert.equal(await panel.locator(".current-columns").count(), 0);
  await button(choices, "Changes").click();
  await readSavedStep(page, "Choose the amount");
  await after
    .getByRole("heading", { name: "Staged amount", exact: true })
    .waitFor();
  if (!(await after.getByLabel("Note text").count()))
    await button(after, "Write note").click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Independent comparison draft"
  );
  await button(
    after.locator(".note").filter({ hasText: "Corrected annotation" }),
    "Delete note"
  ).click();
  await button(after, "Confirm delete note").click();
  await after
    .getByText("Corrected annotation", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Independent comparison draft"
  );
  await button(page, "Back to walkthrough").click();
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Keep ordinary draft"
  );
  await page.getByText("Ordinary card purpose", { exact: true }).waitFor();
  await button(page.locator("#notes"), "Delete note").click();
  await button(page.locator("#notes"), "Confirm delete note").click();
  await page
    .getByText("Delete ordinary", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Keep ordinary draft"
  );

  async function holdCall(name, matches = () => true) {
    let announce, release;
    const seen = new Promise((r) => (announce = r)),
      gate = new Promise((r) => (release = r));
    gates.push(release);
    let held = false;
    const handler = async (route) => {
      const payload = route.request().postDataJSON();
      if (!held && payload.name === name && matches(payload.arguments)) {
        held = true;
        const response = await route.fetch();
        announce();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    };
    await page.route("**/api/call", handler);
    return {
      seen,
      async release() {
        const arrived = page.waitForResponse((response) => {
          const p = response.request().postDataJSON();
          return p?.name === name && matches(p.arguments);
        });
        release();
        await arrived;
        await page.unroute("**/api/call", handler);
        await page.evaluate(
          () =>
            new Promise((r) =>
              globalThis.requestAnimationFrame(() =>
                globalThis.requestAnimationFrame(r)
              )
            )
        );
      },
    };
  }
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  await after
    .getByRole("heading", { name: "Staged amount", exact: true })
    .waitFor();
  await button(after, "Write note").click();
  const latest = button(after, "Use latest notes revision");
  if (await latest.count()) await latest.click();
  await after.getByLabel("Note text").fill("Accepted old text");
  const noteHeld = await holdCall("save_walkthrough_comparison_note");
  await button(after, "Save note").click();
  await noteHeld.seen;
  await after
    .getByLabel("Note text")
    .fill("Newer text must survive old response");
  await noteHeld.release();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Newer text must survive old response"
  );
  await button(after, "Close editor").click();
  const readHeld = await holdCall(
    "get_comparison_walkthrough",
    (a) => a.id === other.id
  );
  await page.locator(`[data-comparison-path="${other.id}"]`).click();
  await readHeld.seen;
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  await after
    .getByRole("heading", { name: "Staged amount", exact: true })
    .waitFor();
  await readHeld.release();
  assert.equal(
    await panel
      .getByRole("heading", { name: "Amount evolution", exact: true })
      .count(),
    1,
    "Late navigation reply cannot replace selected walkthrough"
  );
  // Query requests are separately fenced from authored navigation.
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  const listHeld = await holdCall(
    "list_git_changes",
    (a) => a.query.mode === "compare"
  );
  await button(choices, "Compare").click();
  await listHeld.seen;
  await button(choices, "Changes").click();
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  await listHeld.release();
  assert.equal(await choices.getByLabel("Current base branch").count(), 0);
  await readSavedStep(page, "Choose the amount");
  assert.equal(
    await after.locator("code[data-source-line]").first().innerText(),
    "const amount = 2;"
  );
  // Opposite side changed: old Before text is not silently blessed.
  const stale = await readSavedStep(page, "Expand the calculation");
  const before = stale.locator('[data-git-side="before"]');
  f.write("part.ts", "const amount = 99;\nunchanged\n");
  await button(before, "Write note").click();
  await before.getByLabel("Note text").fill("Keep rejected stale source draft");
  await button(before, "Save note").click();
  await before
    .getByRole("alert")
    .filter({ hasText: /changed|binding/i })
    .waitFor();
  assert.equal(
    await before.getByLabel("Note text").inputValue(),
    "Keep rejected stale source draft"
  );
  assert.equal(
    await panel
      .getByText("These differences have changed.", { exact: false })
      .count(),
    0,
    "No captured/live maintenance banners"
  );
  assert.equal(
    await after.locator("code[data-source-line]").first().innerText(),
    "const amount = 3;"
  );
  await readSavedStep(page, "Choose the amount");
  await button(
    after.locator(".note").filter({ hasText: "Accepted old text" }),
    "Delete note"
  ).click();
  await button(after, "Confirm delete note").click();
  await after
    .getByText("Accepted old text", { exact: true })
    .waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual Chrome retained/adapted regressions: real staged/unstaged authored sources, secondary equal/working choices, note edit/delete/history/revisions, ordinary drafts/deletion, delayed note/navigation/query replies, stale-source rejection without rebinding or maintenance UI."
  );
} finally {
  gates.forEach((release) => release());
  await browser?.close();
  for (const fn of cleanup.reverse()) await fn();
}
