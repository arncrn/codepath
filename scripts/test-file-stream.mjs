import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture } from "../tests/fixtures/authored-comparison.mjs";
const cleanup = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  const { saved } = await authorFixture(f);
  for (let i = 0; i < 40; i++)
    f.write(
      `stream-${String(i).padStart(2, "0")}.ts`,
      `// file ${i}\nexport const value${i} = ${i};\n`
    );
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
      viewport: { width: 1550, height: 1000 },
    }),
    errors = [],
    writes = [],
    reads = [];
  let inflight = 0,
    peak = 0;
  const fileRequest = (request) =>
    request.url().endsWith("/api/call") &&
    request.postDataJSON()?.name === "get_git_file";
  page.on("request", (request) => {
    if (fileRequest(request)) peak = Math.max(peak, ++inflight);
  });
  for (const event of ["requestfinished", "requestfailed"])
    page.on(event, (request) => {
      if (fileRequest(request)) inflight--;
    });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/call")) {
      const p = r.postDataJSON();
      if (p.name === "get_git_file") reads.push(p.arguments.fileId);
      if (!/^(get_|list_|check_)/.test(p.name)) writes.push(p.name);
    }
  });
  await page.goto(f.service.url + "?view=current-changes");
  const panel = page.locator("#current-changes");
  await panel.locator('.git-file-list[data-inventory-ready="true"]').waitFor();
  const files = panel.locator("[data-review-file]");
  assert.equal(
    await files.count(),
    43,
    "All inventory pairs have ordered, scrollable file sections without sidebar clicks"
  );
  await page
    .getByRole("button", { name: "Hide navigation", exact: true })
    .click();
  await panel.hover();
  await page.mouse.wheel(0, 1); // Real reading cancels the initial Notes reveal anchor.
  const tail = files.filter({
    has: page.locator("h2", { hasText: "stream-39.ts" }),
  });
  await tail.scrollIntoViewIfNeeded();
  await tail.locator('code[data-source-line="2"]').waitFor();
  assert.match(await tail.innerText(), /export const value39 = 39;/);
  assert.ok(new Set(reads).size < 43, "No eager read of the entire inventory");
  assert.ok(peak <= 2, `At most two Git source reads, got ${peak}`);
  assert.ok(
    (await panel.locator(".current-file-body").count()) < 12,
    "Bound automatic source DOM, not just network reads"
  );
  assert.equal(
    await panel.locator(".git-file-list .changed-file input:checked").count(),
    0,
    "Scrolling never marks Viewed"
  );
  const staged = panel.locator(
      '[data-review-group="staged"][data-review-path="part.ts"]'
    ),
    unstaged = panel.locator(
      '[data-review-group="unstaged"][data-review-path="part.ts"]'
    );
  await staged.scrollIntoViewIfNeeded();
  await staged
    .locator('[data-current-side="after"] code[data-source-line="1"]')
    .waitFor();
  assert.match(await staged.innerText(), /const amount = 2;/);
  await unstaged.scrollIntoViewIfNeeded();
  await unstaged
    .locator('[data-current-side="after"] code[data-source-line="1"]')
    .waitFor();
  assert.match(await unstaged.innerText(), /const amount = 3;/);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  await unstaged.scrollIntoViewIfNeeded();
  await unstaged
    .getByRole("heading", { name: "Expanded saved calculation", exact: true })
    .waitFor();
  const after = unstaged.locator('[data-current-side="after"]');
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  const editor = after.getByLabel("Note text");
  await editor.fill("Keep editor while reading another file");
  const handle = await editor.elementHandle();
  await tail.scrollIntoViewIfNeeded();
  await tail.locator('code[data-source-line="2"]').waitFor();
  assert.equal(await handle.evaluate((e) => e.isConnected), true);
  assert.equal(
    await handle.inputValue(),
    "Keep editor while reading another file"
  );
  await unstaged.scrollIntoViewIfNeeded();
  assert.equal(
    await handle.evaluate(
      (old, now) => old === now,
      await editor.elementHandle()
    ),
    true
  );
  assert.equal(
    await panel
      .getByRole("button", { name: "Read saved guide source", exact: true })
      .count(),
    0
  );
  const last = panel.locator('[data-review-path="long.ts"]');
  await last.scrollIntoViewIfNeeded();
  await last.locator('code[data-source-line="35"]').waitFor();
  await last
    .getByText("Introduced context block behavior", { exact: true })
    .waitFor();
  assert.equal(
    await panel.locator("[data-review-step-title]").count(),
    3,
    "All authored steps remain labelled beside their files, not a misleading command strip"
  );
  assert.equal(
    await panel.locator(".git-file-list .changed-file input:checked").count(),
    0
  );
  // Hold an accepted old source response across query replacement and an
  // equal-byte return. Durable file IDs are not a file/window lifetime.
  let release,
    announce,
    held = false;
  const gate = new Promise((resolve) => (release = resolve)),
    seen = new Promise((resolve) => (announce = resolve));
  const intercept = async (route) => {
    if (!held && route.request().postDataJSON()?.name === "get_git_file") {
      held = true;
      const response = await route.fetch();
      announce(route.request().postData());
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  };
  await page.route("**/api/call", intercept);
  try {
    await page.goto(f.service.url + "?view=current-changes");
    const heldRequest = await seen;
    await panel.getByRole("button", { name: "Compare", exact: true }).click();
    await panel
      .getByLabel("Current target", { exact: true })
      .selectOption("HEAD");
    await panel
      .getByText("No allowed-path differences.", { exact: true })
      .waitFor();
    const old = page.waitForResponse(
      (r) => r.request().postData() === heldRequest
    );
    release();
    await old;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          globalThis.requestAnimationFrame(() =>
            globalThis.requestAnimationFrame(resolve)
          )
        )
    );
    assert.equal(await files.count(), 0);
    assert.equal(
      await panel.locator("pre").count(),
      0,
      "Late old source cannot repopulate an empty comparison"
    );
    await panel.getByRole("button", { name: "Changes", exact: true }).click();
    await panel
      .locator(
        '[data-review-active="true"] .current-file-body[data-source-state="ready"]'
      )
      .waitFor();
    assert.equal(
      await files.count(),
      43,
      "A recreated, equal-ID inventory gets fresh file lifetimes"
    );
  } finally {
    release?.();
    await page.unroute("**/api/call", intercept);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS all43 current pairs and all3 inline explanations scroll without mandatory navigation clicks; lazy reads, distinct staged/unstaged, same mounted unsaved editor on scroll, no Viewed or authoring writes."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
