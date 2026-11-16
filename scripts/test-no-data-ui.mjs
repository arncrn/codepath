import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { assertNoDataUi, verifyNoDataUi } from "./no-data-ui-check.mjs";
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
        calls = [],
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => {
        if (r.url().endsWith("/api/call")) calls.push(r.postDataJSON().name);
      });
      await page.goto(f.service.url);
      await verifyNoDataUi(page, f);
      assert.equal(
        await page.locator("#notes-tab").getAttribute("class"),
        "active"
      );
      for (const tab of ["data", "variables", "flow"]) {
        await page.evaluate(
          ({ root, tab }) =>
            localStorage.setItem(
              "codepath.reading-context.v1:" + root,
              JSON.stringify({
                version: 1,
                walkthroughId: "preserved-data",
                stepId: "two",
                tab,
                focusNonce: null,
              })
            ),
          { root: fs.realpathSync(f.root), tab }
        );
        await page.reload();
        await page.locator(".code-card.active[data-step=two]").waitFor();
        assert.equal(
          await page
            .locator("#" + (tab === "data" ? "notes" : tab) + "-tab")
            .getAttribute("class"),
          "active"
        );
        await assertNoDataUi(page);
      }
      assert.deepEqual(errors, []);
      assert.equal(
        calls.includes("get_run"),
        false,
        "Reading/polling/restoration must not fetch retired run selection"
      );
      assert.equal(
        calls.includes("record_run"),
        false,
        "No capture writes from the removed UI"
      );
      console.log(
        `PASS actual browser no Data UI ${viewport.width}×${viewport.height}: legacy Data→Notes, Variables/Flow restoration, no hidden run requests.`
      );
    } finally {
      await context.close();
      for (const close of cleanup.reverse()) await close();
    }
  }
} finally {
  await browser.close();
}
