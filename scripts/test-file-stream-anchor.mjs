import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject, allChanges } from "../tests/fixtures/git-project.mjs";
const cleanup = [],
  f = await gitProject({ after: (close) => cleanup.push(close) });
let browser, release;
try {
  f.write("a-first.ts", "// first\n");
  for (let i = 0; i < 12; i++) f.write(`mid-${i}.ts`, "// middle\n");
  f.write(
    "y-long.ts",
    Array.from({ length: 800 }, (_, i) => `// long line ${i}`).join("\n") + "\n"
  );
  f.write("z-tail.ts", "export const tail = true;\n");
  const inventory = await allChanges(f.service),
    long = inventory.files.find((f) => f.file === "y-long.ts");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const manual of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1500, height: 1000 },
    });
    let announce;
    const seen = new Promise((resolve) => (announce = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    let held = false;
    await page.route("**/api/call", async (route) => {
      const p = route.request().postDataJSON();
      if (
        !held &&
        p.name === "get_git_file" &&
        p.arguments.fileId === long.id
      ) {
        held = true;
        const response = await route.fetch();
        announce();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.goto(f.service.url + "?view=current-changes");
    const panel = page.locator("#current-changes");
    await panel.locator(".git-file-list[data-inventory-ready=true]").waitFor();
    const tail = panel.locator('[data-review-path="z-tail.ts"]');
    await panel
      .getByRole("button", { name: "Open untracked z-tail.ts", exact: true })
      .click();
    await seen;
    await tail.locator("code[data-source-line]").waitFor();
    const before = await tail.boundingBox();
    if (manual) {
      await panel.hover();
      await page.mouse.wheel(0, -180);
      await page.waitForTimeout(80);
    }
    release();
    await panel
      .locator('[data-review-path="y-long.ts"] code[data-source-line="800"]')
      .waitFor({ state: "attached" });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          globalThis.requestAnimationFrame(() =>
            globalThis.requestAnimationFrame(() =>
              globalThis.requestAnimationFrame(resolve)
            )
          )
        )
    );
    const after = await tail.boundingBox(),
      viewport = await panel.boundingBox();
    if (manual)
      assert.ok(
        after.y > viewport.y + viewport.height,
        "Manual wheel cancels the jump intent; a late resize must not snap back"
      );
    else
      assert.ok(
        after.y < viewport.y + viewport.height &&
          after.y + after.height > viewport.y,
        `Late upstream height must keep the requested source visible: ${JSON.stringify({ before, after, viewport })}`
      );
    assert.equal(await panel.locator(".changed-file input:checked").count(), 0);
    console.log(
      `PASS delayed800-line neighboring source: ${manual ? "manual reading gesture cancels jump; no snapback" : "explicit jump remains visible"}.`
    );
    await page.close();
  }
} finally {
  release?.();
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
