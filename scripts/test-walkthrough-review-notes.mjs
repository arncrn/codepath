import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { verifyWalkthroughReviewNotes } from "./walkthrough-review-notes-check.mjs";
const cleanup = [],
  f = await gitProject({ after: (c) => cleanup.push(c) });
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
      viewport: { width: 1550, height: 1000 },
    }),
    errors = [],
    writes = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/call")) {
      const { name } = r.postDataJSON();
      if (name !== "project_overview" && !/^(get_|list_|check_)/.test(name))
        writes.push(name);
    }
  });
  await page.goto(f.service.url);
  await verifyWalkthroughReviewNotes(page, f);
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    [],
    "Reading walkthrough notes must never author a second comparison copy"
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  console.log(
    "PASS ordinary walkthrough annotations supplied directly to review, no annotation/progress/focus writes."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
