import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
const artifacts =
  process.env.CODEPATH_TEST_OUTPUT_DIR ||
  path.join(base, ".cache/walkthrough-overview");
fs.mkdirSync(artifacts, { recursive: true });
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "cp-overview-browser-"))
);
const checkout = path.join(root, "checkout with spaces");
for (const file of [
  "examples/function-context/main.go",
  "examples/function-context/overview.md",
  "scripts/create-overview-example.mjs",
  "dist/client.mjs",
]) {
  fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
  fs.copyFileSync(path.join(base, file), path.join(checkout, file));
}
let service, browser;
const releases = [];
const responses = [];
try {
  service = await startProjectService(root, {
    assetsRoot: path.join(base, "dist"),
  });
  const child = spawn(
    process.execPath,
    [path.join(checkout, "scripts/create-overview-example.mjs"), root],
    { timeout: 15000 }
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    output += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    output += text;
  });
  const [exit, signal] = await once(child, "close");
  assert.equal(signal, null, output);
  assert.equal(exit, 0, output);
  assert.match(output, /are ready/);
  const id = "go-function-context-cheat-sheet";
  const saved = await service.call("get_walkthrough", { id });
  assert.equal(
    saved.steps.reduce((n, step) => n + step.notes.length, 0),
    6
  );
  const legacy = await service.call("save_walkthrough", {
    title: "Legacy manual guide",
    steps: [{ id: "legacy", title: "Old card", source: saved.steps[0].source }],
  });
  const disk = path.join(root, ".codepaths/workspace.json");
  const originalBytes = fs.readFileSync(disk, "utf8"),
    originalMtime = fs.statSync(disk).mtimeMs;
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const main = page.locator("#walkthrough-overview");
  const text = page.locator("#overview-text");
  const overviewPage = () => page.locator("#overview-page").click();
  const cardsPage = () => page.locator("#cards-page").click();
  const edit = () =>
    main.getByRole("button", { name: "Edit overview", exact: true }).click();
  const save = () =>
    main.getByRole("button", { name: "Save overview", exact: true }).click();
  const discard = () =>
    main.getByRole("button", { name: "Discard draft", exact: true }).click();
  const read = () => service.call("get_walkthrough", { id });

  await page.goto(service.url);
  await main.waitFor({ state: "visible" });
  await main
    .getByRole("heading", { name: "Mental model", exact: true })
    .waitFor();
  await main
    .getByRole("heading", { name: "Worked example", exact: true })
    .waitFor();
  assert.equal(await page.locator("#walkthrough-cards").isVisible(), false);
  assert.equal(await main.locator(".overview-map button").count(), 4);
  await main.locator('[data-overview-step="invoke"]').click();
  await page
    .locator('[data-step="invoke"].active')
    .waitFor({ state: "visible" });
  assert.equal(
    await page.locator('[data-step="invoke"] .function-context').textContent(),
    "Server.Handle"
  );
  await page
    .locator("#note-text")
    .fill("An unfinished note survives overview navigation.");
  await overviewPage();
  await cardsPage();
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "An unfinished note survives overview navigation."
  );
  await overviewPage();
  await page.reload();
  await main.waitFor({ state: "visible" });
  await cardsPage();
  assert.equal(
    await page.locator(".code-card.active").getAttribute("data-step"),
    "invoke"
  );
  await overviewPage();
  assert.equal(fs.readFileSync(disk, "utf8"), originalBytes);
  assert.equal(
    fs.statSync(disk).mtimeMs,
    originalMtime,
    "Navigation/reload must not save walkthrough data"
  );
  await page.screenshot({ path: path.join(artifacts, "overview.png") });

  // The editor starts from exact raw Markdown; polling and independent
  // walkthrough drafts cannot replace it.
  await edit();
  assert.equal(await text.inputValue(), saved.overview);
  await text.fill("## Unsaved A\n\nKeep this first draft.");
  await page.locator(`[data-path="${legacy.id}"]`).click();
  await page.locator('[data-step="legacy"]').waitFor({ state: "visible" });
  await overviewPage();
  await main.getByText("No overview yet", { exact: true }).waitFor();
  await main
    .getByRole("button", { name: "Use cheat-sheet template", exact: true })
    .click();
  assert.match(await text.inputValue(), /## Worked example/);
  await text.fill("## Unsaved B\n\nKeep this second draft.");
  await page.locator(`[data-path="${id}"]`).click();
  await page.getByRole("heading", { name: saved.title, exact: true }).waitFor();
  await text.waitFor({ state: "visible" });
  assert.equal(
    await text.inputValue(),
    "## Unsaved A\n\nKeep this first draft."
  );
  await page.locator("#refresh").click();
  await page
    .getByRole("status")
    .getByText("Refreshed", { exact: true })
    .waitFor();
  assert.equal(
    await text.inputValue(),
    "## Unsaved A\n\nKeep this first draft."
  );
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.equal(
    await text.inputValue(),
    "## Unsaved A\n\nKeep this first draft."
  );

  const hostile =
    saved.overview +
    '\n## Extra example\n\n**Still passive**\n\n<img src="https://invalid.example/tracker">\n\n<script>globalThis.overviewInjected = true</script>\n\n[unsafe](javascript:alert(1))\n\n[command](command:workbench.action.closeWindow)\n\n[safe](https://example.com/overview)\n';
  await text.fill(hostile);
  await save();
  await text.waitFor({ state: "hidden" });
  assert.equal((await read()).overview, hostile);
  assert.equal(await main.locator("img, script, iframe, style").count(), 0);
  assert.equal(
    await page.evaluate(() => globalThis.overviewInjected),
    undefined
  );
  assert.deepEqual(
    await main
      .locator(".markdown-body a")
      .evaluateAll((links) => links.map((link) => link.href)),
    ["https://example.com/overview"]
  );
  assert.deepEqual(
    (await read()).steps,
    saved.steps,
    "Overview saves must preserve complete source explanations"
  );
  await page.reload();
  await main
    .getByRole("heading", { name: "Extra example", exact: true })
    .waitFor();
  await edit();
  assert.equal(await text.inputValue(), hostile);

  // Concurrent authoring is a conflict, not permission to overwrite.
  await text.fill("## Local draft\n\nDo not overwrite the remote author.");
  const beforeRemote = await read();
  await service.call("save_walkthrough_overview", {
    walkthroughId: id,
    expectedRevision: beforeRemote.revision,
    overview: "## Remote overview\n\nAnother author saved this.",
  });
  await page.locator("#refresh").click();
  await page
    .getByRole("status")
    .getByText("Refreshed", { exact: true })
    .waitFor();
  await save();
  await main
    .getByRole("alert")
    .getByText(/changed elsewhere/)
    .waitFor();
  assert.match(await text.inputValue(), /Local draft/);
  assert.match((await read()).overview, /Remote overview/);
  await discard();
  await main
    .getByRole("heading", { name: "Remote overview", exact: true })
    .waitFor();

  async function holdSave() {
    let acknowledge, captured, finished, failed;
    const handled = new Promise((resolve, reject) => {
      finished = resolve;
      failed = reject;
    });
    responses.push(handled);
    void handled.catch(() => {}); // Awaited by remove/final cleanup, not an unhandled async route.
    const gate = new Promise((resolve) => {
      acknowledge = resolve;
    });
    const received = new Promise((resolve) => {
      captured = resolve;
    });
    releases.push(acknowledge);
    let held = false;
    const handler = async (route) => {
      if (
        route.request().postDataJSON()?.name !== "save_walkthrough_overview" ||
        held
      )
        return route.continue();
      held = true;
      try {
        const response = await route.fetch();
        captured();
        await gate;
        await route.fulfill({ response });
        finished();
      } catch (error) {
        failed(error);
      }
    };
    await page.route("**/api/call", handler);
    return {
      received,
      release: acknowledge,
      remove: async () => {
        await handled;
        await page.unroute("**/api/call", handler);
      },
    };
  }
  await edit();
  await text.fill("## Submitted overview\n\nThis version is being saved.");
  const delayed = await holdSave();
  await save();
  await delayed.received;
  await text.fill("## Newer typing\n\nKeep editing while the save waits.");
  delayed.release();
  await main
    .getByRole("button", { name: "Save overview", exact: true })
    .waitFor();
  assert.match(await text.inputValue(), /Newer typing/);
  assert.match((await read()).overview, /Submitted overview/);
  await delayed.remove();
  await save();
  await text.waitFor({ state: "hidden" });
  assert.match((await read()).overview, /Newer typing/);

  await edit();
  await text.fill("## In flight\n\nThe old editor's save.");
  const oldEditor = await holdSave();
  await save();
  await oldEditor.received;
  await discard();
  await edit();
  await text.fill(
    "## Recreated editor\n\nThis new draft must survive the old reply."
  );
  oldEditor.release();
  await oldEditor.remove();
  await page.locator("#refresh").click();
  await page
    .getByRole("status")
    .getByText("Refreshed", { exact: true })
    .waitFor();
  assert.match(await text.inputValue(), /Recreated editor/);
  await discard();

  await edit();
  await text.fill("## Keep on failure\n\nDo not lose this text.");
  const failSave = async (route) => {
    if (route.request().postDataJSON()?.name === "save_walkthrough_overview")
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated overview failure" }),
      });
    return route.continue();
  };
  await page.route("**/api/call", failSave);
  await save();
  await main
    .getByRole("alert")
    .getByText("Simulated overview failure", { exact: true })
    .waitFor();
  assert.match(await text.inputValue(), /Keep on failure/);
  await page.unroute("**/api/call", failSave);
  await discard();

  const beforeRestore = await read();
  await service.call("save_walkthrough_overview", {
    walkthroughId: id,
    expectedRevision: beforeRestore.revision,
    overview: saved.overview,
  });
  await page.locator("#refresh").click();
  await main
    .getByRole("heading", { name: "Mental model", exact: true })
    .waitFor();

  // Narrow layouts keep both the document and reading-map buttons usable.
  await page.setViewportSize({ width: 760, height: 950 });
  assert.equal(
    await main.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1
    ),
    true
  );
  await page.screenshot({ path: path.join(artifacts, "overview-narrow.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sourceFile = path.join(checkout, "examples/function-context/main.go");
  fs.writeFileSync(
    sourceFile,
    fs
      .readFileSync(sourceFile, "utf8")
      .replace('println("inside callback")', 'println("changed callback")')
  );
  await main.getByText(/Some source cards have changed/).waitFor();
  const prior = (await read()).overview;
  await edit();
  assert.equal(
    await text.inputValue(),
    prior,
    "Source refresh must not regenerate overview prose"
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual Chrome: runnable example, Markdown mental model/examples, card links, legacy empty state, page/card restoration without reader writes, exact editing/persistence, navigation/poll/review-safe drafts, conflicts, delayed ACK/newer typing/recreated editors, failure retention, passive hostile Markdown and narrow layout."
  );
} finally {
  for (const release of releases) release();
  await Promise.allSettled(responses);
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
