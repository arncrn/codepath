import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import {
  chooseReviewFile,
  selectedReviewFile,
} from "./unified-review-check.mjs";
const cleanup = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  const source =
    Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`).join(
      "\n"
    ) + "\n";
  f.write("no-guides.ts", source);
  f.git("add", "--", "no-guides.ts");
  f.write(
    "no-guides.ts",
    source.replace("const line10 = 10;", "const line10 = 100;")
  );
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1550, height: 1000 },
  });
  const errors = [],
    writes = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/call")) {
      const { name } = r.postDataJSON();
      if (!/^(get_|list_|check_)/.test(name)) writes.push(name);
    }
  });
  await page.goto(f.service.url + "?view=current-changes");
  await chooseReviewFile(page, "unstaged", "no-guides.ts");
  const panel = page.locator("#current-changes"),
    checkbox = panel.getByRole("checkbox", {
      name: "Show only changed sections",
      exact: true,
    });
  assert.equal(await checkbox.count(), 1);
  assert.equal(await checkbox.isChecked(), false);
  const numbers = () =>
    selectedReviewFile(page)
      .locator('[data-current-side="after"] code[data-source-line]')
      .evaluateAll((nodes) => nodes.map((n) => Number(n.dataset.sourceLine)));
  assert.equal((await numbers()).length, 20);
  await checkbox.check();
  assert.deepEqual(await numbers(), [7, 8, 9, 10, 11, 12, 13]);
  await chooseReviewFile(page, "staged", "no-guides.ts");
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(
    (await numbers()).length,
    20,
    "All added source is correctly still all changed"
  );
  await chooseReviewFile(page, "unstaged", "no-guides.ts");
  assert.deepEqual(await numbers(), [7, 8, 9, 10, 11, 12, 13]);
  await checkbox.uncheck();
  assert.equal((await numbers()).length, 20);
  assert.doesNotMatch(
    await panel.innerText(),
    /\d+ files · \d+ pairs|files fully Viewed|pairs Viewed|paired steps · comparison/
  );
  assert.equal(
    await panel.locator(".review-note-tabs,.authored-purpose").count(),
    0
  );
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS one clearly named real checkbox works with ZERO guides; on/off and file navigation preserve mode; no invented guide/notes/counters/write calls."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
