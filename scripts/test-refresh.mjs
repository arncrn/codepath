import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { verifyRefresh } from "./refresh-check.mjs";
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
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(f.service.url);
      await verifyRefresh(page, f);
      assert.deepEqual(errors, []);
      await page
        .getByRole("button", { name: "Review changes", exact: true })
        .click();
      const review = page.locator("#current-changes");
      await review
        .locator(".git-file-list[data-inventory-ready=true]")
        .waitFor();
      await review
        .getByRole("button", {
          name: "Open unstaged refresh-flow.ts",
          exact: true,
        })
        .click();
      await review
        .locator(
          '[data-review-path="refresh-flow.ts"] [data-source-state=ready]'
        )
        .waitFor();
      const fileId = await review
        .locator('[data-review-path="refresh-flow.ts"]')
        .getAttribute("data-review-file");
      const incomplete = async (route) => {
        if (route.request().postDataJSON().name === "list_git_changes") {
          const response = await route.fetch(),
            data = await response.json();
          await route.fulfill({
            response,
            json: { ...data, complete: false, nextCursor: undefined },
          });
        } else await route.continue();
      };
      await page.route("**/api/call", incomplete);
      await page.locator("#refresh").click();
      await page
        .locator(".refresh-status")
        .filter({
          hasText: /Refresh failed:.*Inventory continuation unavailable/,
        })
        .waitFor();
      await page.unroute("**/api/call", incomplete);
      const unavailable = async (route) => {
        const body = route.request().postDataJSON();
        if (body.name === "get_git_file" && body.arguments.fileId === fileId)
          await route.fulfill({
            status: 503,
            json: { error: "Selected source unavailable" },
          });
        else await route.continue();
      };
      await page.route("**/api/call", unavailable);
      await page.locator("#refresh").click();
      await page
        .locator(".refresh-status")
        .filter({ hasText: /Refresh failed:.*Selected source unavailable/ })
        .waitFor();
      await page.unroute("**/api/call", unavailable);
      let release, notify;
      const gate = new Promise((r) => (release = r)),
        held = new Promise((r) => (notify = r)),
        draining = [];
      const delayed = (route) => {
        const body = route.request().postDataJSON();
        const work = (async () => {
          if (
            body.name === "get_git_file" &&
            body.arguments.fileId === fileId
          ) {
            const response = await route.fetch();
            notify();
            await gate;
            await route.fulfill({ response });
          } else await route.continue();
        })();
        draining.push(work);
        return work;
      };
      await page.route("**/api/call", delayed);
      try {
        await page.locator("#refresh").click();
        await held;
        assert.equal(await page.locator("#refresh").isDisabled(), true);
        assert.equal(
          await page.locator(".refresh-status").textContent(),
          "Refreshing…"
        );
      } finally {
        release();
        await Promise.all(draining);
        await page.unroute("**/api/call", delayed);
      }
      await page
        .locator(".refresh-status")
        .filter({ hasText: /^Refreshed$/ })
        .waitFor();
      await review
        .locator(
          '[data-review-path="refresh-flow.ts"] [data-source-state=ready]'
        )
        .waitFor();
      f.write("refresh-unavailable.ts", "x".repeat(8 * 1024 * 1024 + 1));
      await page.locator("#refresh").click();
      await page
        .locator(".refresh-status")
        .filter({ hasText: /Refresh failed:.*sources are unavailable/ })
        .waitFor();
      await review
        .locator('.git-file-list[data-inventory-ready="true"]')
        .waitFor();
      assert.equal(
        await review
          .locator(".git-file-list")
          .getByRole("button", { name: /Open .*refresh-unavailable.ts/ })
          .count(),
        1,
        "A complete inventory with an unavailable candidate must stay complete and readable"
      );
      fs.unlinkSync(path.join(f.root, "refresh-unavailable.ts"));
      await page.locator("#refresh").click();
      await page
        .locator(".refresh-status")
        .filter({ hasText: /^Refreshed$/ })
        .waitFor();
      assert.deepEqual(errors, []);
      console.log(
        `PASS actual browser Refresh ${viewport.width}×${viewport.height}: incomplete/unavailable/held selected source cannot falsely finish; retry succeeds.`
      );
    } finally {
      await context.close();
      for (const close of cleanup.reverse()) await close();
    }
  }
} finally {
  await browser.close();
}
