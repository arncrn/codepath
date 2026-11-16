import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { gitProject, allChanges } from "../tests/fixtures/git-project.mjs";
import { verifyCoverage, verifyGuideToggle } from "./review-coverage-check.mjs";
import {
  readReviewStep,
  chooseReviewFile,
  waitViewed,
} from "./unified-review-check.mjs";

const cleanup = [];
const f = await gitProject({ after: (fn) => cleanup.push(fn) });
let browser;
const releaseGates = [];
try {
  f.write("part.ts", "inserted\nconst amount = 1;\nunchanged\nend\n");
  f.write("binary.bin", Buffer.from([0, 255]));
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1550, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.service.url + "?view=current-changes");
  const panel = page.locator("#current-changes");
  await panel
    .getByRole("heading", { name: "Current changes", exact: true })
    .waitFor({ timeout: 5000 });
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  assert.equal(
    await panel.locator('.changed-file input[type="checkbox"]').count(),
    2
  );
  const checkbox = panel.getByRole("checkbox", {
    name: "Viewed unstaged part.ts",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Open unstaged part.ts", exact: true })
    .click();
  await panel
    .locator('[data-current-side="after"] code[data-source-line="2"]')
    .waitFor();
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(
    await panel.locator(".review-note-tabs").count(),
    0,
    "Diff-only files need no authored ceremony"
  );
  for (const width of [1550, 760])
    for (const zoom of [1, 1.25, 2]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator("body").evaluate((el, zoom) => {
        el.style.zoom = String(zoom);
      }, zoom);
      const geometry = await panel.evaluate((el) => {
        const box = (selector) => {
          const e = el.querySelector(selector),
            r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width };
        };
        return {
          before: box('[data-current-side="before"]'),
          after: box('[data-current-side="after"]'),
          lineBefore: box(
            '[data-current-side="before"] code[data-source-line="1"]'
          ),
          lineAfter: box(
            '[data-current-side="after"] code[data-source-line="2"]'
          ),
        };
      });
      assert.ok(geometry.after.x > geometry.before.x);
      assert.ok(
        Math.abs(geometry.lineBefore.y - geometry.lineAfter.y) < 2,
        JSON.stringify({ width, zoom, geometry })
      );
    }
  await page.locator("body").evaluate((el) => {
    el.style.zoom = "1";
  });
  await page.setViewportSize({ width: 1550, height: 1000 });
  await checkbox.click();
  await waitViewed(page, "Viewed unstaged part.ts", true);
  await page.reload();
  await waitViewed(page, "Viewed unstaged part.ts", true);
  assert.equal(await checkbox.isChecked(), true);
  await f.reopen();
  await page.goto(f.service.url + "?view=current-changes");
  await waitViewed(page, "Viewed unstaged part.ts", true);
  assert.equal(
    await checkbox.isChecked(),
    true,
    "Actual service restart preserves exact manual progress"
  );
  await checkbox.click();
  await waitViewed(page, "Viewed unstaged part.ts", false);
  await panel
    .locator('[data-current-side="after"] code[data-source-line="2"]')
    .waitFor();
  let announce, release;
  const seen = new Promise((done) => {
    announce = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  releaseGates.push(release);
  let held = false;
  const handler = async (route) => {
    const input = route.request().postDataJSON();
    if (!held && input.name === "set_git_viewed") {
      held = true;
      const response = await route.fetch();
      announce();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  };
  await page.route("**/api/call", handler);
  await checkbox.click();
  let seenTimer;
  try {
    await Promise.race([
      seen,
      new Promise((_, reject) => {
        seenTimer = setTimeout(
          () => reject(Error("Held public Viewed ACK was not observed")),
          5000
        );
      }),
    ]);
  } finally {
    clearTimeout(seenTimer);
  }
  await panel
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await waitViewed(page, "Viewed unstaged part.ts", true);
  await checkbox.click();
  await waitViewed(page, "Viewed unstaged part.ts", false);
  const oldAckArrived = page.waitForResponse(
    (response) => response.request().postDataJSON()?.name === "set_git_viewed"
  );
  release();
  await oldAckArrived;
  await page.unroute("**/api/call", handler);
  await page.evaluate(
    () =>
      new Promise((done) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(done)
        )
      )
  );
  assert.equal(
    await checkbox.isChecked(),
    false,
    "Retired ACK cannot resurrect a cleared/recreated progress scope"
  );
  await panel
    .locator('[data-current-side="after"] code[data-source-line="2"]')
    .waitFor();
  const output = path.resolve(
    process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/review-coverage"
  );
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "A-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.screenshot({
    path: path.join(output, "A-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1550, height: 1000 });
  f.write("authored.ts", "export function run() {\n  return 1;\n}\n");
  f.git("add", "--", "authored.ts");
  f.git("commit", "--quiet", "-m", "owned alignment fixture");
  f.write(
    "authored.ts",
    "// inserted before function\nexport function run() {\n  const value = 1;\n  return value;\n}\n"
  );
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "authored.ts");
  const source = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const side = (title, endLine) => ({
    title,
    purpose: "An independent optional purpose.",
    startLine: 1,
    endLine,
    notes: [],
    variables: [],
    notApplicable: {
      notes: "No extra block explanation needed in this authored fixture.",
      variables: "No variable explanation needed in this fixture.",
    },
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Aligned authored windows",
    listId: list.listId,
    steps: [
      {
        id: "alignment",
        title: "Independent authored step",
        fileId: file.id,
        binding: source.binding,
        before: side("Before", 3),
        after: side("Long after title ".repeat(9), 5),
      },
      {
        id: "unrelated",
        title: "Explicit independent excerpts",
        fileId: file.id,
        binding: source.binding,
        before: side("Independent former window", 1),
        after: { ...side("Independent later window", 5), startLine: 5 },
      },
    ],
  });
  await chooseReviewFile(page, "unstaged", "authored.ts");
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  const authored = page.locator("#git-comparisons");
  await authored
    .getByRole("heading", { name: "Aligned authored windows", exact: true })
    .waitFor();
  await readReviewStep(page, "Independent authored step");
  const alignment = await authored.evaluate((el) => {
    const rect = (selector) =>
      el.querySelector(selector).getBoundingClientRect().y;
    return [
      rect('[data-current-side="before"] code[data-source-line="1"]'),
      rect('[data-current-side="after"] code[data-source-line="2"]'),
    ];
  });
  assert.ok(
    Math.abs(alignment[0] - alignment[1]) < 2,
    `Authored real corresponding lines align despite insertion and independent title heights: ${alignment}`
  );
  await readReviewStep(page, "Explicit independent excerpts");
  const independent = authored.locator('[data-inline-explanation="unrelated"]');
  assert.equal(await independent.count(), 2);
  assert.equal(
    await independent.locator("code[data-source-line]").count(),
    0,
    "An explanation does not create another source display"
  );
  assert.equal(
    await independent
      .locator(".diff-padding,.diff-added,.diff-removed")
      .count(),
    0,
    "Unrelated excerpt windows never acquire fake correspondence or unbounded padding"
  );
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  await chooseReviewFile(page, "unstaged", "authored.ts");
  await authored
    .getByRole("combobox", {
      name: "Comparison explanation to edit",
      exact: true,
    })
    .selectOption({ label: "Independent authored step" });
  await authored
    .getByRole("heading", { name: "Aligned authored windows", exact: true })
    .waitFor();
  assert.equal(
    await authored
      .getByRole("combobox", {
        name: "Comparison explanation to edit",
        exact: true,
      })
      .inputValue(),
    "alignment"
  );
  await verifyCoverage(page, f, "browser");
  await verifyGuideToggle(page, f, "browser");
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual Chrome A: complete diff-only file navigation, genuine insertion row padding, parallel 1550/760 at 100/125/200%, manual Viewed/save/reload/uncheck."
  );
} finally {
  for (const release of releaseGates) release();
  await browser?.close();
  for (const fn of cleanup.reverse()) await fn();
}
