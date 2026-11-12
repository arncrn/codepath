import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { gitProject, allChanges } from "../tests/fixtures/git-project.mjs";
import { side } from "../tests/fixtures/authored-comparison.mjs";
import { chooseReviewFile } from "./unified-review-check.mjs";
import { verifyAuthoredHunks } from "./authored-hunks-check.mjs";
const cleanup = [];
const f = await gitProject({ after: (close) => cleanup.push(close) });
let browser;
try {
  const before =
    "const amount = 1;\n" +
    Array.from({ length: 20 }, (_, i) => `// unchanged ${i + 2}`).join("\n") +
    "\nconst tail = 1;\n";
  f.write("part.ts", before);
  f.git("add", "--", "part.ts");
  f.write(
    "part.ts",
    before.replace("amount = 1", "amount = 2").replace("tail = 1", "tail = 2")
  );
  const list = await allChanges(f.service),
    file = list.files.find(
      (file) => file.file === "part.ts" && file.group === "unstaged"
    ),
    wire = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Only first change explained",
    listId: list.listId,
    steps: [
      {
        id: "first",
        title: "Explain first change",
        fileId: file.id,
        binding: wire.binding,
        before: side("Before amount", "Before purpose"),
        after: side("After amount", "After purpose"),
      },
    ],
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
      viewport: { width: 1550, height: 1000 },
    }),
    writes = [],
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/call")) {
      const p = r.postDataJSON();
      if (!/^(get_|list_|check_)/.test(p.name)) writes.push(p.name);
    }
  });
  await page.goto(f.service.url + "?view=current-changes");
  await chooseReviewFile(page, "unstaged", "part.ts");
  const panel = page.locator("#current-changes"),
    focus = panel.getByRole("checkbox", {
      name: "Show only changed sections",
      exact: true,
    });
  await panel.getByText("After purpose", { exact: true }).waitFor();
  assert.equal(await focus.isChecked(), false);
  assert.equal(
    await panel.getByRole("button", { name: "Notes", exact: true }).count(),
    2,
    "Initial full-file view loads admitted Notes without first turning focus on"
  );
  await focus.check();
  const numbers = async (side) =>
    panel
      .locator(
        `.current-diff-host [data-current-side="${side}"] code[data-source-line],.current-diff-host .guide-display [data-git-side="${side}"] code[data-source-line]`
      )
      .evaluateAll((nodes) =>
        nodes.map((node) => Number(node.dataset.sourceLine))
      );
  assert.ok(
    (await numbers("after")).includes(22),
    "Second actual change must NOT disappear just because only the first hunk has an authored explanation"
  );
  for (const side of ["before", "after"])
    assert.deepEqual(await numbers(side), [1, 2, 3, 4, 19, 20, 21, 22]);
  assert.equal(await panel.locator("pre").count(), 2);
  assert.equal(
    await panel
      .locator('[data-current-side="after"] [data-source-hunk]')
      .count(),
    2,
    "Two distinct changed sections need explicit source range headings"
  );
  assert.equal(
    await panel
      .locator('[data-current-side="after"] [data-source-gap]')
      .count(),
    1
  );
  await focus.uncheck();
  assert.equal(
    await panel
      .locator('[data-current-side="after"] code[data-source-line]')
      .count(),
    22
  );
  assert.equal(
    await panel.getByRole("button", { name: "Notes", exact: true }).count(),
    2,
    "Unchecking changes source extent, never removes Before/After Notes"
  );
  assert.equal(
    await panel.locator(".optional-explanations").count(),
    0,
    "Do not replace admitted Notes with optional-guide footer"
  );
  await focus.check();
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  console.log(
    "PASS current annotated diff retains BOTH changes as two labeled sections; only first is annotated; no source/draft/note/Viewed mutation."
  );
  await verifyAuthoredHunks(page, f);
  assert.deepEqual(writes, [
    "save_walkthrough_comparison_note",
    "save_walkthrough_comparison_note",
  ]);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  for (const close of cleanup.reverse()) await close();
}
