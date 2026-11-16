import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { verifyReviewFlow } from "./review-flow-check.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const viewport of [
    { width: 1500, height: 1050 },
    { width: 760, height: 900 },
  ]) {
    const cleanup = [],
      f = await gitProject({ after: (c) => cleanup.push(c) }),
      context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage(),
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
      await verifyReviewFlow(page, f, { popup: true });
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, []);
      console.log(
        "PASS actual review Flow clipping at " +
          viewport.width +
          "×" +
          viewport.height
      );
    } finally {
      await context.close();
      for (const close of cleanup.reverse()) await close();
    }
  }
} finally {
  await browser.close();
}
