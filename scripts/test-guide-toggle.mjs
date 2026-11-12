import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { verifyGuideToggle } from "./review-coverage-check.mjs";

const cleanup = [];
const fixture = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1550, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  fixture.write("part.ts", "const amount = 2;\nunchanged\n");
  // The chosen guide file sorts after these entries, on a later page.
  for (let i = 0; i < 111; i++)
    fixture.write(`aaa-other-${i}.txt`, "Other changed file\n");
  assert.equal(
    (
      await fixture.service.call("list_git_changes", {
        query: { mode: "changes" },
      })
    ).complete,
    false,
    "The regression must exercise a partial inventory page"
  );
  await page.goto(fixture.service.url + "?view=current-changes");
  await verifyGuideToggle(page, fixture, "browser");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
