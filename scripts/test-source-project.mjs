import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-source-browser-"));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
for (let i = 0; i < 310; i++)
  write(
    `a-source/file-${i}.ts`,
    `export function unrelated${i}() { return ${i}; }\n`
  );
for (let i = 0; i < 5100; i++) write(`b-assets/file-${i}.json`, "{}");
write(
  "zz/target.ts",
  "export function lateTarget() { return 42; }\n// exclusive needle\n"
);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  await service.call("save_walkthrough", {
    id: "read",
    title: "Read",
    steps: [
      {
        id: "start",
        title: "Start",
        source: { file: "a-source/file-0.ts", symbol: "unrelated0" },
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
  await page.locator('.code-card[data-step="start"]').waitFor();

  // Filename discovery must reach beyond both old limits, without a giant DOM list.
  await page
    .getByRole("textbox", { name: "Find source files", exact: true })
    .fill("zz/target");
  await page.locator('#files [data-file="zz/target.ts"]').click();
  await page
    .locator("#range-preview")
    .filter({ hasText: "return 42" })
    .waitFor();
  assert.equal(await page.locator("#range-file").inputValue(), "zz/target.ts");
  await page.locator("#close-modal").click();

  // Both filename and symbol browsing can continue past their first page.
  await page.locator("#add").click();
  const modal = page.locator("#modal");
  await modal
    .getByRole("button", { name: "More files", exact: true })
    .waitFor();
  while (
    !(await page.locator('#range-file option[value="zz/target.ts"]').count())
  ) {
    const previousCount = await page.locator("#range-file option").count();
    await modal
      .getByRole("button", { name: "More files", exact: true })
      .click();
    await page.waitForFunction(
      (count) =>
        globalThis.document.querySelector("#range-file").options.length > count,
      previousCount
    );
  }
  await page.locator("#symbol-query").fill("unrelated");
  await page.locator(".choice").first().waitFor();
  while (
    !(await page.locator(".choice").filter({ hasText: "unrelated309" }).count())
  ) {
    await modal
      .getByRole("button", { name: "More results", exact: true })
      .click();
    await page
      .locator('#symbol-results [role="status"]')
      .waitFor({ state: "hidden" });
  }
  await page.locator("#close-modal").click();

  await page.locator("#add").click();
  await page.locator("#symbol-query").fill("lateTarget");
  await page.locator(".choice").filter({ hasText: "lateTarget" }).click();
  await page.locator(".code-card").filter({ hasText: "return 42" }).waitFor();
  let walk = await service.call("get_walkthrough", { id: "read" });
  assert.ok(
    walk.steps.some(
      (step) =>
        step.source.file === "zz/target.ts" &&
        step.source.symbol === "lateTarget"
    )
  );

  await page.locator("#add").click();
  await page.locator("#symbol-query").fill("exclusive needle");
  await page.locator("#text-search").click();
  await page.locator(".choice").filter({ hasText: "exclusive needle" }).click();
  await page.locator(".code-card").nth(2).waitFor();
  walk = await service.call("get_walkthrough", { id: "read" });
  assert.equal(walk.steps.length, 3);
  assert.equal(walk.steps[2].source.file, "zz/target.ts");

  // Late lookup success and failure cannot write or replace a newer dialog.
  for (const failed of [false, true]) {
    await page.locator("#add").click();
    await page.locator("#symbol-query").fill("lateTarget");
    await page.locator(".choice").filter({ hasText: "lateTarget" }).waitFor();
    const arrived = Promise.withResolvers(),
      release = Promise.withResolvers(),
      delivered = Promise.withResolvers();
    const hold = async (route) => {
      if (route.request().postDataJSON()?.name !== "inspect_source")
        return route.continue();
      const response = await route.fetch();
      arrived.resolve();
      await release.promise;
      await route.fulfill(
        failed
          ? { status: 400, json: { error: "Old lookup failed" } }
          : { response }
      );
      delivered.resolve();
    };
    await page.route("**/api/call", hold);
    await page.locator(".choice").filter({ hasText: "lateTarget" }).click();
    await arrived.promise;
    await page.locator("#close-modal").click();
    await page.locator("#new-path").click();
    await page.locator("#path-name").fill("Keep this newer draft");
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
      await page.locator("#path-name").inputValue(),
      "Keep this newer draft"
    );
    assert.equal(await page.locator("#error").isVisible(), false);
    assert.equal(
      (await service.call("get_walkthrough", { id: "read" })).steps.length,
      3
    );
    await page.unroute("**/api/call", hold);
    await page.locator("#close-modal").click();
  }
  assert.deepEqual(errors, []);
  console.log(
    "Source discovery/picker passed: 311 source files, 5,100 assets, late filename/symbol/text selection and cancelled lookup protection."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
