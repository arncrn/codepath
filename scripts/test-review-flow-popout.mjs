/* global window, document -- Owned browser UI. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorReviewFlow } from "./review-flow-check.mjs";
const cleanup = [],
  f = await gitProject({ after: (c) => cleanup.push(c) });
let browser;
try {
  const { walk, file } = await authorReviewFlow(f);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
      viewport: { width: 1500, height: 1050 },
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
  await page.locator(`[data-path="${walk.id}"]`).click();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const root = page.locator("#current-changes"),
    toggle = page.getByRole("button", { name: "Flow", exact: true }),
    canvas = page.locator("#review-flow-canvas"),
    flow = page.locator("#review-flow-panel");
  await root.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  await toggle.click();
  await flow.locator("svg").waitFor();
  const before = await root.boundingBox();
  await page.evaluate(() => {
    const open = window.open;
    window.restoreReviewFlowOpen = () => (window.open = open);
    window.open = () => null;
  });
  await flow.getByRole("button", { name: "Pop out Flow", exact: true }).click();
  await page
    .locator("#error")
    .filter({ hasText: "blocked the Flow window" })
    .waitFor();
  assert.equal(
    await canvas.isVisible(),
    true,
    "Failed open must keep the inline diagram"
  );
  await page.evaluate(() => window.restoreReviewFlowOpen());
  await page.locator("#error").click();
  const opened = page.waitForEvent("popup");
  await flow.getByRole("button", { name: "Pop out Flow", exact: true }).click();
  const child = await opened;
  await child.locator('[data-flow-node="s0"]').waitFor();
  await page.waitForFunction(
    () => document.querySelector("#review-flow-canvas").hidden,
    {},
    { timeout: 2000 }
  );
  assert.equal(
    await flow.count(),
    0,
    "Inline diagram is unmounted after successful open"
  );
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  const after = await root.boundingBox();
  assert.ok(
    after.height - before.height > 150,
    "Comparison reader reclaims the inline graph space"
  );
  await child.locator('[data-flow-node="s0"]').click();
  const mark = root.locator(
    `[data-review-path="${file}"][data-review-active=true] [data-current-side="after"] [data-flow-source]`
  );
  await mark.getByText("emoji", { exact: true }).waitFor();
  // Reopening inline and popping out again focuses the existing window, but
  // must still collapse the newly shown inline canvas.
  await toggle.click();
  await flow.locator("svg").waitFor();
  await flow.getByRole("button", { name: "Pop out Flow", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#review-flow-canvas").hidden,
    {},
    { timeout: 2000 }
  );
  await child.locator('[data-flow-node="s1"]').click();
  await root
    .locator('[data-current-side="after"] [data-flow-source]')
    .getByText("😀", { exact: true })
    .waitFor();
  const closed = child.waitForEvent("close");
  await child
    .getByRole("button", { name: "Close window", exact: true })
    .click();
  await closed;
  assert.equal(
    await canvas.isVisible(),
    false,
    "Closing the separate window does not unexpectedly reopen inline Flow"
  );
  await toggle.click();
  await flow.locator("svg").waitFor();
  assert.deepEqual(
    await f.service.call("get_walkthrough", { id: walk.id }),
    walk
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  console.log(
    "PASS review Flow pop-out: failed open retains inline, successful/new and reused window collapse inline and reclaim reader space, detached exact navigation survives, explicit inline reopen and saved data/progress untouched."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
