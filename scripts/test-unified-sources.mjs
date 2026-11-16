import { readVariable } from "./unified-review-check.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject } from "../tests/fixtures/git-project.mjs";
import { authorFixture } from "../tests/fixtures/authored-comparison.mjs";
import {
  chooseReviewFile,
  selectedReviewFile,
} from "./unified-review-check.mjs";
const cleanup = [],
  f = await gitProject({ after: (c) => cleanup.push(c) });
let browser;
try {
  const { saved } = await authorFixture(f);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
      viewport: { width: 1550, height: 1000 },
    }),
    errors = [],
    writes = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/call")) {
      const { name } = r.postDataJSON();
      if (name !== "project_overview" && !/^(get_|list_|check_)/.test(name))
        writes.push(name);
    }
  });
  await page.goto(f.service.url + "?view=current-changes");
  await chooseReviewFile(page, "unstaged", "part.ts");
  await page.locator(`[data-comparison-path="${saved.id}"]`).click();
  const panel = page.locator("#current-changes"),
    source = selectedReviewFile(page);
  await source
    .getByText("Expanded saved calculation block behavior", { exact: true })
    .waitFor();
  await source
    .locator('[data-current-side="after"]')
    .getByRole("button", { name: /^Variables(?: · \d+)?$/, exact: true })
    .click();
  await readVariable(source, "Expanded saved calculation named amount");
  assert.ok((await source.locator(".code .source-attachment").count()) > 0);
  // Only BEFORE/index changes. Equal AFTER is not permission to paint old notes.
  f.write("part.ts", "const amount = 99;\nunchanged\n");
  f.git("add", "--", "part.ts");
  f.write(
    "part.ts",
    "const amount = 3;\nconst expanded = amount + 1;\nconsole.log(expanded);\n// additional saved context\n"
  );
  await panel
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await source
    .locator('[data-current-side="before"] code[data-source-line="1"]')
    .filter({ hasText: "99" })
    .waitFor();
  await source
    .getByText("Expanded saved calculation block behavior", { exact: true })
    .waitFor();
  await readVariable(source, "Expanded saved calculation named amount");
  assert.ok((await source.getByText(/Out of date/).count()) > 0);
  assert.equal(
    await source
      .locator(".code .source-attachment,.code [data-block-note-id]")
      .count(),
    0
  );
  assert.equal(
    await source
      .getByRole("button", { name: "Save note", exact: true })
      .count(),
    0
  );
  assert.match(
    await source
      .locator('[data-current-side="after"] code[data-source-line="1"]')
      .innerText(),
    /amount = 3/
  );
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  const wp = path.join(f.root, ".codepaths/workspace.json"),
    before = fs.readFileSync(wp);
  await panel.getByRole("button", { name: "Compare", exact: true }).click();
  await panel
    .getByLabel("Current target", { exact: true })
    .selectOption("HEAD");
  await panel
    .getByText("No allowed-path differences.", { exact: true })
    .waitFor();
  const notes = panel.locator('[data-unmatched-explanation="expanded"]');
  await notes.scrollIntoViewIfNeeded();
  await readVariable(notes, "Expanded saved calculation named amount");
  assert.equal(await panel.locator("pre").count(), 0);
  assert.equal(
    await panel
      .getByRole("button", { name: "Read saved guide source", exact: true })
      .count(),
    0
  );
  assert.deepEqual(fs.readFileSync(wp), before);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS BEFORE-only full-pair mismatch preserves visible Notes/Variables but refuses both overlays/editing; honest current AFTER, empty comparison retains explanations, no source/notes/Viewed writes."
  );
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
