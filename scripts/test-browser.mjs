import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
const backend = process.env.CODEPATH_BROWSER_BACKEND ?? "node";
assert.ok(["node", "go"].includes(backend));
fs.mkdirSync(path.join(base, ".cache"), { recursive: true });
const root = fs.mkdtempSync(path.join(base, ".cache/browser-react-"));
fs.cpSync(path.join(base, "examples/checkout"), root, {
  recursive: true,
  filter: (file) => !file.split(path.sep).includes(".codepaths"),
});
fs.writeFileSync(
  path.join(root, "escape.ts"),
  "export function escapeSource() {\n  return '<img src=x onerror=\"window.sourceExecuted=true\">';\n}\n\nexport const context = 1;\n"
);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.join(base, "dist"),
    demo: true,
    backend,
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator(".code-card").first().waitFor();
  assert.equal(await page.locator("#paths button").count(), 3);
  assert.equal(
    await page.getByText("Source-linked", { exact: true }).count(),
    0
  );
  for (const quantity of [2, 1]) {
    await page.locator("#demo").click();
    const demo = page.frameLocator("iframe.demo-frame");
    await demo.getByLabel("Notebooks · $12 each").fill(String(quantity));
    await demo
      .getByRole("button", { name: "Submit order →", exact: true })
      .click();
    await demo
      .getByText(
        "Run captured. Close the example to return to the walkthrough.",
        {
          exact: true,
        }
      )
      .waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(
      await page.locator("#data-tab,#data-panel,#runs,#run-file").count(),
      0
    );
    await page.locator('[data-select="normalize"]').click();
    const runs = await service.call("list_runs", {
      walkthroughId: "checkout-" + backend,
    });
    const run = await service.call("get_run", { id: runs[0].id });
    assert.equal(run.events.length, 7);
    assert.ok(run.events.every((e) => typeof e.sourceHash === "string"));
    const output = run.events.find((e) => e.stepId === "normalize").output;
    assert.equal(output.email, "ada@example.com");
    assert.equal(output.total, quantity === 2 ? 2160 : 1200);
    assert.equal(output.discount, quantity === 2 ? 240 : 0);
    assert.equal(
      run.walkthroughId,
      "checkout-" + backend,
      "The example still retains its captured execution through the API"
    );
  }
  // Create and add source using React forms, not direct DOM injection.
  const title = 'Review <img src=x onerror="window.titleExecuted=true">';
  await page.locator("#new-path").click();
  await page.locator("#path-name").fill(title);
  await page.locator("#path-description").fill("Browser migration regression.");
  await page
    .getByRole("button", { name: "Create walkthrough →", exact: true })
    .click();
  await page.locator("#symbol-query").fill("escapeSource");
  await page.locator(".choice").click();
  await page
    .locator(".code-card .filename")
    .filter({ hasText: "escape.ts" })
    .waitFor();
  await page.locator("#title").filter({ hasText: title }).waitFor();
  assert.equal(await page.locator("#title img, .code img").count(), 0);
  assert.equal(
    await page.evaluate(
      () => window.titleExecuted || window.sourceExecuted || false
    ),
    false
  );
  const walkId = await page
    .locator("#paths button.selected")
    .getAttribute("data-path");
  let walk = await service.call("get_walkthrough", { id: walkId });
  const stepId = walk.steps[0].id;
  assert.equal(walk.steps[0].explanation, "");
  assert.equal(await page.locator(".reason .badge").count(), 0);
  assert.match(
    await page.locator(".reason").innerText(),
    /No code explanation yet/
  );
  await page.locator('[data-action="full"]').click();
  assert.equal(await page.locator(".code .line").count(), 6);
  await page.locator('[data-action="full"]').click();
  await page.locator("#notes-tab").click();
  assert.equal(await page.getByText("Add a note", { exact: true }).count(), 1);
  // Persist a note but hold its response: polling can expose the saved note
  // before the original POST returns. Its completion must not clear a new draft.
  let releaseNote;
  const noteResponse = new Promise((resolve) => {
    releaseNote = resolve;
  });
  await page.route("**/api/call", async (route) => {
    const body = route.request().postDataJSON();
    if (body.name === "add_note" && body.arguments.author === "You") {
      const response = await route.fetch();
      await noteResponse;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.locator("#note-text").fill("Keep this original note.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByText("Keep this original note.", { exact: true }).waitFor();
  await page.locator("#note-text").fill("Unsubmitted draft survives polling.");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/call") &&
      response.request().postDataJSON().name === "add_note"
  );
  releaseNote();
  await savedResponse;
  await service.call("add_note", {
    walkthroughId: walkId,
    stepId,
    body: "Concurrent external-agent note.",
    author: "Browser test",
  });
  await page
    .getByText("Concurrent external-agent note.", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Unsubmitted draft survives polling."
  );
  // A real source edit must stale old annotations, not silently rebaseline them.
  const file = path.join(root, "escape.ts");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("return ", "return /* changed */ ")
  );
  await page.locator("#refresh").click();
  await page.locator("#notes .badge.warning").first().waitFor();
  assert.equal(await page.locator("#notes .badge.warning").count(), 2);
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Unsubmitted draft survives polling."
  );
  // Explicit range selection, reorder/remove and keyboard navigation retain IDs.
  await page.locator("#add").click();
  await page.locator("#range-file").selectOption("api/service.mjs");
  await page.waitForFunction(() =>
    document.querySelector("#range-preview").textContent.includes("createOrder")
  );
  await page.locator("#range-start").fill("1");
  await page.locator("#range-end").fill("3");
  await page.locator("#range-add").click();
  await page.locator(".code-card").nth(1).waitFor();
  assert.equal(
    await page.locator(".code-card").first().locator(".reason .badge").count(),
    0
  );
  assert.equal(
    await page
      .locator(".code-card")
      .nth(1)
      .locator(".reason .badge")
      .innerText(),
    "Connection not verified"
  );
  await page
    .locator(".code-card")
    .nth(1)
    .locator('[data-action="left"]')
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".code-card .filename")
      .textContent.includes("api/service.mjs")
  );
  await page
    .locator(".code-card")
    .first()
    .locator('[data-action="right"]')
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".code-card .filename")
      .textContent.includes("escape.ts")
  );
  await page.locator("#title").click();
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    await page.locator(".code-card.active").getAttribute("data-step"),
    stepId
  );
  await page.keyboard.press("ArrowRight");
  assert.notEqual(
    await page.locator(".code-card.active").getAttribute("data-step"),
    stepId
  );
  await page
    .locator(".code-card")
    .nth(1)
    .locator('[data-action="remove"]')
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".code-card").length === 1
  );
  const retained = await service.call("record_run", {
    walkthroughId: walkId,
    label: "Retained API fixture",
    mode: "example",
    origin: "Browser test fixture, not observed execution.",
    events: [{ stepId, input: { quantity: 1 }, output: { ok: true } }],
  });
  assert.deepEqual(
    await service.call("get_run", { id: retained.id }),
    retained
  );
  assert.equal(
    await page.locator("#data-tab,#data-panel,#run-file,#import-run").count(),
    0
  );
  // Changing the viewport must not lose the selected path or create errors.
  await page.setViewportSize({ width: 540, height: 900 });
  assert.equal(await page.locator(".code-card").count(), 1);
  assert.equal(await page.locator("#error").isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.locator(".code-card").first().waitFor();
  await page.locator("#paths button").filter({ hasText: title }).click();
  await page.locator("#notes-tab").click();
  await page.getByText("Keep this original note.", { exact: true }).waitFor();
  walk = await service.call("get_walkthrough", { id: walkId });
  assert.equal(walk.steps[0].id, stepId);
  assert.equal(walk.steps[0].notes.length, 2);
  assert.equal(walk.steps[0].notes[0].stale, true);
  assert.deepEqual(errors, []);
  console.log(
    "Browser React integration passed (" +
      backend +
      "): real seven-checkpoint captures for quantities 1/2, forms, escaped source/text, range selection, full-file view, notes/drafts during polling, stale annotations, reorder/remove, keyboard navigation, preserved API runs without Data/import UI, narrow viewport and reload persistence."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
