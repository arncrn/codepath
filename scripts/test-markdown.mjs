import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";
import { verifyMarkdown } from "./markdown-check.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-markdown-"));
fs.writeFileSync(
  path.join(root, "authoring.ts"),
  'export function calculate(price: number, quantity: number) {\n  const amount = price * quantity;\n  return amount; // <img src="https://invalid.example/source">\n}\n'
);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  await service.call("save_walkthrough", {
    title: "Original reading position",
    steps: [
      {
        id: "original",
        title: "Original",
        source: { file: "authoring.ts", symbol: "calculate" },
      },
    ],
  });
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
  await page.locator(".code-card").waitFor();
  const result = await verifyMarkdown(
    page,
    (name, args) => service.call(name, args),
    async (link) => {
      await page.context().route("https://example.invalid/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<p>Disposable link destination</p>",
        })
      );
      const popup = page.waitForEvent("popup");
      await link.click();
      const opened = await popup;
      await opened.waitForLoadState();
      assert.equal(opened.url(), "https://example.invalid/docs?q=1&v=2");
      assert.equal(await opened.evaluate(() => globalThis.opener), null);
      await opened.close();
    }
  );
  async function verifySavedReading() {
    await page.locator(`#paths [data-path="${result.walkthroughId}"]`).click();
    await page.locator('.code-card[data-step="markdown"]').waitFor();
    for (const note of result.notes) {
      await page.locator(`#${note.tab}-tab`).click();
      const entry = page.locator(`[data-explanation-id="${note.id}"]`);
      assert.equal(
        await entry.locator("strong").textContent(),
        `Edited ${note.tab === "notes" ? "Notes" : "Variables"}`
      );
      await entry.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = page.locator(`#${note.tab}-panel .annotation-editor`);
      assert.equal(
        await editor.getByLabel("Reviewed explanation").inputValue(),
        note.body
      );
      await editor
        .getByRole("button", { name: "Keep draft and close", exact: true })
        .click();
    }
  }
  await page.reload();
  await verifySavedReading();
  const beforeRestart = await service.call("get_walkthrough", {
    id: result.walkthroughId,
  });
  await service.close();
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  assert.deepEqual(
    await service.call("get_walkthrough", { id: result.walkthroughId }),
    beforeRestart
  );
  await page.goto(service.url);
  await verifySavedReading();
  const artifacts = path.resolve(
    process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/markdown"
  );
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({
    path: path.join(artifacts, "variables-browser.png"),
  });
  await page.locator("#notes-tab").click();
  await page.screenshot({ path: path.join(artifacts, "notes-browser.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS explicit HTTP(S) browser link action with no opener; raw Markdown survives full page reload and real service restart without storage/revision changes."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
