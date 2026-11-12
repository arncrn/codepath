import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture } from "../tests/fixtures/authored-comparison.mjs";
import {
  mainSource,
  helperSource,
  fixtureSteps,
  fixtureGraph,
} from "../tests/fixtures/semantic-flow.mjs";
const cleanup = [];
const f = await gitProject({ after: (fn) => cleanup.push(fn) });
let browser;
try {
  const { saved } = await authorFixture(f);
  f.write("main.mjs", mainSource);
  f.write("helper.mjs", helperSource);
  const walk = await f.service.call("save_walkthrough", {
    id: "composed-flow",
    title: "Flow beside B",
    steps: fixtureSteps,
  });
  await f.service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph: fixtureGraph(walk),
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
  await page.goto(f.service.url);
  await page.locator('[data-path="composed-flow"]').click();
  await page.locator("#notes-tab").click();
  await page.locator("#note-text").fill("Ordinary draft survives B reading");
  await page.locator("#flow-tab").click();
  await page.locator("#flow-panel svg .node").first().waitFor();
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  const panel = page.locator("#git-comparisons");
  await panel
    .getByRole("heading", { name: "Amount evolution", exact: true })
    .waitFor();
  assert.equal(
    await page.locator("#flow-panel svg").count(),
    0,
    "Hidden ordinary Flow disposes its render rather than working behind B"
  );
  const before = panel
    .locator('[data-comparison-column="before"] .authored-card')
    .first();
  const after = panel
    .locator('[data-comparison-column="after"] .authored-card')
    .first();
  assert.ok((await after.boundingBox()).x > (await before.boundingBox()).x);
  await page.locator('[data-path="composed-flow"]').click();
  await page.locator("#flow-panel svg .node").first().waitFor();
  await page.locator("#notes-tab").click();
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Ordinary draft survives B reading"
  );
  await page.locator("#flow-tab").click();
  await page
    .locator('#flow-panel svg [data-flow-step="helper"]')
    .first()
    .click();
  await page.locator('.code-card.active[data-step="helper"]').waitFor();
  await page.locator("#notes-tab").click();
  assert.equal(await page.locator("#note-text").inputValue(), "");
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS Flow + B host/sidebar composition, parallel columns, hidden render disposal, independent ordinary drafts and read-only B preservation."
  );
} finally {
  await browser?.close();
  for (const fn of cleanup.reverse()) await fn();
}
