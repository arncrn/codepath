import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture } from "../tests/fixtures/authored-comparison.mjs";
import { verifyGlobalFocus } from "./global-focused-check.mjs";
const cleanup = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  const { saved } = await authorFixture(f);
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
  await verifyGlobalFocus(page, f, saved.id);
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, [], "Global display toggling is read-only");
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
