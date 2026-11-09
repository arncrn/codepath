import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
const artifacts =
  process.env.CODEPATH_TEST_OUTPUT_DIR ||
  path.join(base, ".cache/dialog-races");
fs.mkdirSync(artifacts, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-repair-dialog-"));
const source =
  "export function first() { return 1; }\nexport function second() { return 2; }\n";
fs.writeFileSync(path.join(root, "flow.ts"), source);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.join(base, "dist"),
  });
  await service.call("save_walkthrough", {
    id: "dialog-races",
    title: "Repair dialog races",
    steps: [
      {
        id: "first",
        title: "First",
        source: { file: "flow.ts", symbol: "first" },
        explanation: "Original explanation",
      },
    ],
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator('.code-card[data-step="first"]').waitFor();
  for (const failed of [false, true]) {
    await page
      .getByRole("button", { name: "Repair source reference", exact: true })
      .click();
    await page.locator("#range-file").selectOption("flow.ts");
    await page.locator("#range-add:not([disabled])").waitFor();
    await page.locator("#range-start").fill("2");
    await page.locator("#range-end").fill("2");
    if (failed)
      fs.writeFileSync(
        path.join(root, "flow.ts"),
        source.replace("return 2", "return 99")
      );
    const arrived = Promise.withResolvers(),
      release = Promise.withResolvers(),
      delivered = Promise.withResolvers();
    await page.route("**/api/call", async (route) => {
      if (route.request().postDataJSON()?.name !== "repair_step_source")
        return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), failed ? 400 : 200);
      arrived.resolve();
      await release.promise;
      await route.fulfill({ response });
      delivered.resolve();
    });
    await page.locator("#range-add").click();
    await arrived.promise;
    await page.locator("#close-modal").click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    await page.locator("#new-path").click();
    const title = failed
      ? "Preserve after a stale repair error"
      : "Preserve after an old repair success";
    const description =
      "This newer creation draft belongs to another dialog intent.";
    await page.locator("#path-name").fill(title);
    await page.locator("#path-description").fill(description);
    release.resolve();
    await delivered.promise;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          globalThis.requestAnimationFrame(() =>
            globalThis.requestAnimationFrame(resolve)
          )
        )
    );
    assert.equal(
      await page.locator("#create-form").count(),
      1,
      "A delayed repair must not close the newer creation dialog."
    );
    assert.equal(await page.locator("#path-name").inputValue(), title);
    assert.equal(
      await page.locator("#path-description").inputValue(),
      description
    );
    assert.equal(
      await page.locator("#modal-error").count(),
      0,
      "A stale repair error must not replace a newer dialog's context."
    );
    await page.screenshot({
      path: path.join(
        artifacts,
        failed ? "failure-preserves-draft.png" : "success-preserves-draft.png"
      ),
    });
    await page.unroute("**/api/call");
    await page.locator("#close-modal").click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    fs.writeFileSync(path.join(root, "flow.ts"), source);
    console.log(
      `PASS delayed repair ${failed ? "failure" : "success"} preserves the newer dialog, both draft fields and its error context.`
    );
  }
  await page
    .getByRole("button", { name: "Repair source reference", exact: true })
    .click();
  await page.locator("#range-file").selectOption("flow.ts");
  await page.locator("#range-add:not([disabled])").waitFor();
  await page.locator("#range-start").fill("1");
  await page.locator("#range-end").fill("1");
  await page.locator("#range-add").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  const repaired = await service.call("get_walkthrough", {
    id: "dialog-races",
  });
  assert.equal(repaired.steps[0].source.startLine, 1);
  assert.equal(repaired.steps[0].explanationReviewRequired, true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS current repair closes its own dialog and retains deliberate explanation-review requirements."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
