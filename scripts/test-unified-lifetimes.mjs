import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture, side } from "../tests/fixtures/authored-comparison.mjs";
import { chooseReviewFile } from "./unified-review-check.mjs";

const cleanup = [],
  releases = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  const { saved, list, first } = await authorFixture(f);
  const other = await f.service.call("create_comparison_walkthrough", {
    title: "Other lifetime",
    listId: list.listId,
    steps: [
      {
        id: "other",
        title: "Other",
        fileId: first.file.id,
        binding: first.binding,
        before: side("Other before", "Other before purpose"),
        after: side("Other after", "Other after purpose"),
      },
    ],
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1550, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          globalThis.requestAnimationFrame(() =>
            globalThis.requestAnimationFrame(resolve)
          )
        )
    );
  async function hold(name, matches = () => true, all = false) {
    let seen,
      release,
      held = false;
    const arrived = new Promise((resolve) => {
        seen = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      });
    releases.push(release);
    const handler = async (route) => {
      const payload = route.request().postDataJSON();
      if (
        (!held || all) &&
        payload.name === name &&
        matches(payload.arguments)
      ) {
        held = true;
        const response = await route.fetch();
        seen();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    };
    await page.route("**/api/call", handler);
    return {
      seen: () =>
        Promise.race([
          arrived,
          delay(15000).then(() => {
            throw Error("Owned HTTP gate timeout: " + name);
          }),
        ]),
      release: async () => {
        const response = page.waitForResponse((r) => {
          const p = r.request().postDataJSON();
          return p?.name === name && matches(p.arguments);
        });
        release();
        await response;
        await page.unroute("**/api/call", handler);
        await settle();
      },
    };
  }
  await page.goto(f.service.url + "?view=current-changes");
  const panel = page.locator("#current-changes"),
    after = page.locator(
      '#current-changes [data-review-active="true"] [data-git-side="after"]'
    );
  await chooseReviewFile(page, "staged", "part.ts");
  const guide = page.locator(`[data-comparison-path="${saved.id}"]`),
    otherGuide = page.locator(`[data-comparison-path="${other.id}"]`);
  const oldRead = await hold(
    "get_comparison_walkthrough",
    (a) => a.id === saved.id
  );
  await guide.click();
  await oldRead.seen();
  const original = saved.steps[0].annotations.notes.find(
    (n) => n.side === "after" && !n.variableName
  );
  await f.service.call("save_walkthrough_comparison_note", {
    walkthroughId: saved.id,
    stepId: "initial",
    side: "after",
    binding: first.binding,
    noteId: original.id,
    expectedRevision: saved.steps[0].annotations.revision,
    body: "Newer public revision survives A-B-A",
    author: "Human",
    attachments: original.attachments,
  });
  await otherGuide.click();
  await after.getByText("Other after purpose", { exact: true }).waitFor();
  await guide.click();
  await after
    .getByText("Newer public revision survives A-B-A", { exact: true })
    .waitFor();
  await oldRead.release();
  assert.equal(
    await after
      .getByText("Newer public revision survives A-B-A", { exact: true })
      .count(),
    1
  );
  // Another guide does not cover the unstaged pair; its exact public link
  // still opens the admitted guide/step. Full-file mode itself keeps Notes.
  await otherGuide.click();
  await after.getByText("Other after purpose", { exact: true }).waitFor();
  await chooseReviewFile(page, "unstaged", "part.ts");
  await panel
    .getByRole("button", {
      name: "Amount evolution · Expand the calculation",
      exact: true,
    })
    .click();
  await chooseReviewFile(page, "staged", "part.ts");
  await after
    .getByText("Newer public revision survives A-B-A", { exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Old rejected revision A");
  const current = await f.service.call("get_comparison_walkthrough", {
    id: saved.id,
  });
  await f.service.call("save_walkthrough_comparison_note", {
    walkthroughId: saved.id,
    stepId: "initial",
    side: "before",
    binding: first.binding,
    expectedRevision: current.steps[0].annotations.revision,
    body: "Concurrent public note",
    author: "Human",
    attachments: [],
  });
  const oldError = await hold(
    "save_walkthrough_comparison_note",
    (a) => a.body === "Old rejected revision A"
  );
  await after.getByRole("button", { name: "Save note", exact: true }).click();
  await oldError.seen();
  await guide.click();
  await guide.click();
  await after
    .getByRole("heading", { name: "Staged amount", exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after
    .getByRole("button", { name: "Use latest notes revision", exact: true })
    .click();
  await after.getByLabel("Note text").fill("Accepted fresh lifetime B");
  const newAck = await hold(
    "save_walkthrough_comparison_note",
    (a) => a.body === "Accepted fresh lifetime B"
  );
  await after.getByRole("button", { name: "Save note", exact: true }).click();
  await newAck.seen();
  await oldError.release();
  assert.equal(
    await after
      .getByRole("button", { name: "Save note", exact: true })
      .isDisabled(),
    true,
    "Old error/finally cannot end a new lifetime's busy state"
  );
  assert.equal(
    await after.getByRole("alert").count(),
    0,
    "Old error cannot appear in recreated editor"
  );
  await newAck.release();
  await after.getByLabel("Note text").waitFor({ state: "detached" });
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Ordinary resume draft");
  await page
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  await settle();
  let hiddenReads = 0;
  const count = (request) => {
    if (
      request.url().endsWith("/api/call") &&
      request.postDataJSON().name === "get_comparison_walkthrough"
    )
      hiddenReads++;
  };
  page.on("request", count);
  await delay(5300);
  page.off("request", count);
  assert.equal(
    hiddenReads,
    0,
    "Ordinary reading must not poll hidden saved guides"
  );
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  await chooseReviewFile(page, "staged", "part.ts");
  await after
    .getByRole("heading", { name: "Staged amount", exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Ordinary resume draft"
  );
  // The old deep link has a one-shot, cancelable initial guide intent.
  const summaries = await hold(
    "list_comparison_walkthroughs",
    () => true,
    true
  );
  await page.goto(f.service.url + "?view=changes");
  await summaries.seen();
  await page
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  await summaries.release();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  assert.equal(
    await panel
      .getByRole("checkbox", {
        name: "Show only changed sections",
        exact: true,
      })
      .isChecked(),
    false,
    "Canceled legacy intent must not enable focus; full-file Notes may load normally"
  );
  await panel.locator('[data-review-active="true"] pre').first().waitFor();
  assert.equal(
    await panel.locator('[data-review-active="true"] pre').count(),
    2
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS public async lifetimes: held guide A-B-A, same-guide exact link, old rejected ACK/error/finally vs new busy editor, hidden-poll suspension/draft resume, canceled legacy initial intent."
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
