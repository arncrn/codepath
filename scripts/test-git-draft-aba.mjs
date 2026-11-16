import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture, side } from "../tests/fixtures/authored-comparison.mjs";
import {
  readReviewStep,
  chooseReviewFile,
  selectedReviewFile,
} from "./unified-review-check.mjs";

const cleanup = [];
const f = await gitProject({ after: (fn) => cleanup.push(fn) });
let browser, release;
try {
  const { saved, list, first } = await authorFixture(f);
  const other = await f.service.call("create_comparison_walkthrough", {
    title: "Other authored draft",
    listId: list.listId,
    steps: [
      {
        id: "other",
        title: "Other step",
        fileId: first.file.id,
        binding: first.binding,
        before: side("Other before", "Separate before"),
        after: side("Other after", "Separate after"),
      },
    ],
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
  await page.goto(f.service.url + "?view=changes");
  const after = selectedReviewFile(page).locator('[data-current-side="after"]');
  const before = selectedReviewFile(page).locator(
    '[data-current-side="before"]'
  );
  const second = after;
  const button = (scope, name) =>
    scope.getByRole("button", {
      name:
        name === "Notes" || name === "Variables"
          ? new RegExp("^" + name + "(?: · \\d+)?$")
          : name,
      exact: true,
    });
  const choose = async (walk, title) => {
    await chooseReviewFile(page, "staged", "part.ts");
    await page.locator(`[data-comparison-path="${walk.id}"]`).click();

    await after.getByRole("heading", { name: title, exact: true }).waitFor();
  };
  await choose(other, "Other after");
  await button(after, "Write note").click();
  await after.getByLabel("Note text").fill("Independent walkthrough draft");
  await choose(saved, "Staged amount");
  await readReviewStep(page, "Expand the calculation");
  await second
    .getByRole("heading", { name: "Expanded saved calculation", exact: true })
    .waitFor();
  await button(second, "Write note").click();
  await second.getByLabel("Note text").fill("Independent second card draft");
  await readReviewStep(page, "Choose the amount");
  await before
    .getByRole("heading", { name: "Original amount", exact: true })
    .waitFor();
  await button(before, "Write note").click();
  await before.getByLabel("Note text").fill("Independent before draft");
  await button(after, "Write note").click();
  await after.getByLabel("Note text").fill("Accepted A");
  let announce;
  const seen = new Promise((r) => (announce = r)),
    gate = new Promise((r) => (release = r));
  let held = false;
  await page.route("**/api/call", async (route) => {
    const p = route.request().postDataJSON();
    if (
      !held &&
      p.name === "save_walkthrough_comparison_note" &&
      p.arguments.body === "Accepted A"
    ) {
      held = true;
      const response = await route.fetch();
      announce();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await button(after, "Save note").click();
  await seen;
  await choose(other, "Other after");
  await choose(saved, "Staged amount");
  await after.getByText("Accepted A", { exact: true }).waitFor();
  await button(after, "Write note").click();
  await button(after, "Use latest notes revision").click();
  await after.getByLabel("Note text").fill("Accepted B");
  await button(after, "Save note").click();
  await after.getByText("Accepted B", { exact: true }).waitFor();
  await after.getByLabel("Note text").waitFor({ state: "detached" });
  await button(after, "Write note").click();
  await after.getByLabel("Note text").fill("Fresh C must survive");
  const editB = () =>
    button(
      after.locator(".review-notes .note").filter({ hasText: "Accepted B" }),
      "Edit"
    );
  await editB().click();
  await after.getByLabel("Note text").fill("Independent edit draft");
  await button(after, "Close editor").click();
  await button(after, "Variables").click();
  await button(after, "Write variable explanation").click();
  await after.getByLabel("Note text").fill("Independent variable draft");
  await after.getByLabel("Variable name").fill("amount");
  await button(after, "Close editor").click();
  await button(after, "Notes").click();
  await button(after, "Write note").click();
  await after.getByLabel("Note text").focus();
  const arrived = page.waitForResponse((response) => {
    const p = response.request().postDataJSON();
    return (
      p?.name === "save_walkthrough_comparison_note" &&
      p.arguments.body === "Accepted A"
    );
  });
  release();
  await arrived;
  await page.evaluate(
    () =>
      new Promise((r) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(r)
        )
      )
  );
  assert.equal(
    await after.getByLabel("Note text").count(),
    1,
    "Held A must not remove recreated C editor"
  );
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Fresh C must survive"
  );
  assert.equal(
    await after
      .getByLabel("Note text")
      .evaluate((e) => e === globalThis.document.activeElement),
    true
  );
  await editB().click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Independent edit draft"
  );
  await button(after, "Variables").click();
  await button(after, "Write variable explanation").click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Independent variable draft"
  );
  assert.equal(await after.getByLabel("Variable name").inputValue(), "amount");
  await button(before, "Write note").click();
  assert.equal(
    await before.getByLabel("Note text").inputValue(),
    "Independent before draft"
  );
  await readReviewStep(page, "Expand the calculation");
  await second
    .getByRole("heading", { name: "Expanded saved calculation", exact: true })
    .waitFor();
  await button(second, "Write note").click();
  assert.equal(
    await second.getByLabel("Note text").inputValue(),
    "Independent second card draft"
  );
  await choose(other, "Other after");
  await button(after, "Write note").click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Independent walkthrough draft"
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual Chrome held accepted A / unmount / save B / recreated C; independent walkthrough/card/side/plain/Variable/create/edit drafts and focus survive, older revision cannot replace B."
  );
} finally {
  release?.();
  await browser?.close();
  for (const fn of cleanup.reverse()) await fn();
}
