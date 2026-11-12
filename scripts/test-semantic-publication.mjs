import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";
import {
  prepareSemanticFlowPublication,
  publishSemanticFlow,
} from "./author-semantic-flow.mjs";

// Disposable demonstration of the SAME guarded payload recipe intended for the
// original guide. It reads actual maintained application source, not private data.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-real-flow-"));
let service, browser;
try {
  for (const file of [
    "ui/walkthrough-flow.tsx",
    "ui/notes.tsx",
    "walkthrough-flow.mts",
    "workspace.mts",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(file, path.join(root, file));
  }
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  await service.call("save_walkthrough", {
    id: "review-ticket-28",
    title: "Review · source-bound semantic Flow",
    steps: [],
  });
  const plan = await prepareSemanticFlowPublication(service);
  const { walkthrough, readiness } = await publishSemanticFlow(service, plan);
  assert.equal(readiness.ready, true);
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator('[data-step="semantic-flow-view"]').waitFor();
  await page.locator("#flow-tab").click();
  await page.locator("#flow-panel svg .node").first().waitFor();
  assert.equal(
    await page.locator("#flow-panel svg .node").count(),
    walkthrough.flow.nodes.length
  );
  assert.equal(
    await page.locator("#flow-panel svg .flowchart-link").count(),
    walkthrough.flow.edges.length
  );
  await page
    .locator('#flow-panel svg [data-flow-step="semantic-flow-svg"]')
    .first()
    .click();
  await page
    .locator('.code-card.active[data-step="semantic-flow-svg"]')
    .waitFor();
  await page.getByRole("button", { name: "Fit diagram", exact: true }).click();
  fs.mkdirSync(".cache/walkthrough-flow", { recursive: true });
  await page
    .locator("#flow-panel")
    .screenshot({
      path: ".cache/walkthrough-flow/actual-guide-source-fit.png",
    });
  fs.writeFileSync(
    ".cache/walkthrough-flow/publication-example.json",
    JSON.stringify(
      {
        nodes: walkthrough.flow.nodes.length,
        edges: walkthrough.flow.edges.length,
        readiness,
        graph: walkthrough.flow,
      },
      null,
      2
    ) + "\n"
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS actual application source publication recipe: ${walkthrough.steps.length} three-home cards, ${walkthrough.flow.nodes.length} nodes, ${walkthrough.flow.edges.length} typed edges, current bindings, Chrome card navigation and fit. Disposable only; original viewer untouched.`
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
