import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-card-layout-"));
fs.writeFileSync(
  path.join(root, "card.ts"),
  "export function example() {\n" +
    Array.from({ length: 90 }, (_, i) => `  const item${i} = ${i};`).join(
      "\n"
    ) +
    "\n  return item0;\n}\n"
);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  await service.call("save_walkthrough", {
    title: "Card layout regression",
    steps: [
      {
        id: "card",
        title: "One reader for Notes and Variables",
        source: { file: "card.ts", symbol: "example" },
        explanation:
          "Renders each note body as Markdown while retaining explicit classification, source colors and review warnings.",
      },
    ],
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator('.code-card[data-step="card"]').waitFor();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 700 },
    { width: 800, height: 600 },
    { width: 520, height: 550 },
  ]) {
    await page.setViewportSize(viewport);
    for (const zoom of [1, 1.25, 2]) {
      await page.evaluate((zoom) => {
        globalThis.document.documentElement.style.zoom = String(zoom);
      }, zoom);
      const geometry = await page
        .locator('.code-card[data-step="card"]')
        .evaluate((card) => {
          const footer = card.querySelector(":scope > footer"),
            code = card.querySelector(":scope > .code");
          const box = card.getBoundingClientRect(),
            bottom = footer.getBoundingClientRect();
          return {
            cardBottom: box.bottom,
            footerBottom: bottom.bottom,
            codeHeight: code.clientHeight,
            codeScrollHeight: code.scrollHeight,
            clippedControls: [...footer.querySelectorAll("button")].filter(
              (button) => button.getBoundingClientRect().bottom > box.bottom - 1
            ).length,
          };
        });
      assert.ok(
        geometry.footerBottom <= geometry.cardBottom - 0.5,
        `Footer clipped at ${viewport.width}x${viewport.height}, zoom ${zoom}: ${JSON.stringify(geometry)}`
      );
      assert.equal(geometry.clippedControls, 0);
      assert.ok(
        geometry.codeHeight > 0,
        "Source pane remains available and scrollable"
      );
      assert.ok(geometry.codeScrollHeight > geometry.codeHeight);
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS source-card footer and all controls stay inside the card at desktop/narrow/constrained heights and 100/125/200% layout zoom; source remains scrollable."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
