import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { allChanges } from "../tests/fixtures/git-project.mjs";
import { chooseReviewFile } from "./unified-review-check.mjs";

// Public file/toggle UI plus read-only service tools, shared with disposable native.
export async function verifyGlobalFocus(frame, f, guideId, label = "browser") {
  const file = "package.json";
  const before =
    "\ufeff{\r\n" +
    Array.from(
      { length: 80 },
      (_, i) =>
        `  "setting${String(i + 1).padStart(3, "0")}": ${i + 1}${i === 79 ? "" : ","}`
    ).join("\r\n") +
    "\r\n}\r\n";
  const after = before
    .replace('"setting020": 20', '"setting020": 200')
    .replace('"setting070": 70', '"setting070": 700');
  f.write(file, before);
  f.git("add", "--", file);
  f.write(file, after);
  const insert = Array.from(
    { length: 20 },
    (_, i) => `const line${i + 1} = ${i + 1};`
  );
  f.write("focus-insert.ts", insert.join("\n") + "\n");
  f.git("add", "--", "focus-insert.ts");
  f.write(
    "focus-insert.ts",
    [
      ...insert.slice(0, 10),
      "const extraA = 1;",
      "const extraB = 2;",
      ...insert.slice(10),
    ].join("\n") + "\n"
  );
  f.write("focus-eof.ts", insert.join("\n"));
  f.git("add", "--", "focus-eof.ts");
  f.write(
    "focus-eof.ts",
    insert.join("\n").replace("const line10 = 10;", "const line10 = 100;")
  );
  f.write("focus-all-new.ts", insert.slice(0, 10).join("\n"));
  f.write("focus-empty.ts", "");
  f.write(".gitattributes", "focus-normalized.txt text eol=lf\n");
  f.git("add", "--", ".gitattributes");
  f.write("focus-normalized.txt", "alpha\r\nbeta\r\ngamma\r\n");
  f.git("add", "--", "focus-normalized.txt");
  f.write("focus-normalized.txt", "alpha\r\nchanged\r\ngamma\r\n");
  const list = await allChanges(f.service),
    target = list.files.find(
      (item) => item.file === file && item.group === "unstaged"
    );
  assert.ok(target);
  const wire = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: target.id,
  });
  assert.equal(wire.before.content, before);
  assert.equal(wire.after.content, after);
  const saved = await f.service.call("get_comparison_walkthrough", {
    id: guideId,
  });
  assert.equal(
    saved.steps.some((step) => step.fileId === target.id),
    false,
    "This regression MUST exercise a file without an authored excerpt"
  );
  const progress = await f.service.call("get_git_viewed", {
    listId: list.listId,
  });
  if (!(await frame.locator("#current-changes").isVisible()))
    await frame
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
  const active = frame.locator("[data-comparison-path].selected");
  if (await active.count()) await active.click();
  await chooseReviewFile(frame, "unstaged", file);
  const panel = frame.locator("#current-changes"),
    guide = frame.locator(`[data-comparison-path="${guideId}"]`);
  // A native coverage fixture spans multiple inventory pages. Compare stable
  // inventory/progress only after enumeration and the exact-pair projection load.
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  await panel
    .locator('input[aria-label="Viewed unstaged package.json"]:enabled')
    .waitFor();
  const focusCheckbox = panel.getByRole("checkbox", {
    name: "Show only changed sections",
    exact: true,
  });
  assert.equal(
    await focusCheckbox.count(),
    1,
    "Focus must be one real, clearly named checkbox"
  );
  assert.doesNotMatch(
    await panel.innerText(),
    /\d+ files · \d+ pairs|files fully Viewed|pairs Viewed|paired steps · comparison/
  );
  assert.equal(
    await panel
      .locator(`.git-file-list [data-comparison-path="${guideId}"]`)
      .count(),
    1,
    "The existing toggle must be above the changed-file controls, not left in the project sidebar"
  );
  assert.equal(
    await frame.locator(`aside [data-comparison-path="${guideId}"]`).count(),
    0,
    "Move, do not duplicate the toggle in review mode"
  );
  assert.equal(await guide.count(), 1);
  async function assertPlacement() {
    await focusCheckbox.scrollIntoViewIfNeeded();
    const position = await focusCheckbox.evaluate((element) => {
      const files = element.closest(".git-file-list"),
        toggle = element.getBoundingClientRect(),
        row = files.querySelector(".changed-file").getBoundingClientRect();
      return { bottom: toggle.bottom, firstFileTop: row.top };
    });
    assert.ok(
      position.bottom <= position.firstFileTop + 2,
      JSON.stringify(position)
    );
  }
  await assertPlacement();
  async function assertQuietHeader() {
    const text = await panel.locator(".comparison-heading").innerText();
    for (const phrase of [
      "Manual Viewed progress is not approval or correctness.",
      "Choose an optional guide from Walkthroughs.",
      "No matching explanation for this source pair.",
      "Diff only",
    ])
      assert.equal(
        text.includes(phrase),
        false,
        "Remove requested label: " + phrase
      );
    assert.doesNotMatch(
      text,
      /Guide:\s/,
      "Remove the prefixed guide-title status row, not saved guide data"
    );
  }
  await assertQuietHeader();
  const numbers = (side) =>
    panel
      .locator(`[data-current-side="${side}"] code[data-source-line]`)
      .evaluateAll((nodes) =>
        nodes.map((node) => Number(node.dataset.sourceLine))
      );
  assert.equal((await numbers("after")).length, 82);
  const names = await panel
      .locator(".git-file-list .changed-file > button")
      .allTextContents(),
    checks = await panel
      .locator('.git-file-list .changed-file input[type="checkbox"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: node.getAttribute("aria-label"),
          checked: node.checked,
        }))
      );
  await guide.click();
  await panel
    .locator(".current-diff-host > h2")
    .filter({ hasText: file })
    .waitFor();
  assert.ok((await guide.getAttribute("class")).includes("selected"));
  await assertQuietHeader();
  const expected = [18, 19, 20, 21, 22, 23, 24, 68, 69, 70, 71, 72, 73, 74];
  assert.deepEqual(
    await numbers("after"),
    expected,
    "Global ON must focus package.json even without notes, rather than leaving all82 source lines"
  );
  assert.deepEqual(await numbers("before"), expected);
  assert.equal(await panel.locator("pre").count(), 2);
  assert.equal(await panel.locator(".guide-display").count(), 0);
  assert.equal(
    await panel.locator(".authored-purpose, .review-note-tabs").count(),
    0,
    "No invented notes, N/A or guide cards for the unannotated file"
  );
  for (const side of ["before", "after"]) {
    const column = panel.locator(`[data-current-side="${side}"]`);
    assert.equal(await column.locator("[data-source-gap]").count(), 3);
    assert.equal(
      await column
        .locator(
          "[data-source-gap] .line-number,[data-source-gap] code[data-source-line]"
        )
        .count(),
      0,
      "Omission markers are NOT numbered/selectable source"
    );
    assert.equal(
      await column.locator("[data-source-gap]").first().textContent(),
      "… unchanged lines omitted …"
    );
    assert.equal(
      (
        await column.locator('code[data-source-line="21"]').textContent()
      ).endsWith("\r"),
      true,
      "CRLF bytes preserved"
    );
  }
  const page = typeof frame.page === "function" ? frame.page() : frame;
  for (const width of [1550, 760])
    for (const zoom of [1, 1.25, 2]) {
      await page.setViewportSize({ width, height: 1000 });
      await frame
        .locator("body")
        .evaluate((element, zoom) => (element.style.zoom = String(zoom)), zoom);
      await assertPlacement();
      const geometry = await panel.evaluate((element) =>
        ["before", "after"].map((side) => {
          const pane = element
              .querySelector(`[data-current-side="${side}"] pre`)
              .getBoundingClientRect(),
            line = element
              .querySelector(
                `[data-current-side="${side}"] code[data-source-line="71"]`
              )
              .getBoundingClientRect();
          return { x: pane.x, y: pane.y, line: line.y };
        })
      );
      assert.ok(
        geometry[1].x > geometry[0].x &&
          Math.abs(geometry[1].y - geometry[0].y) < 2 &&
          Math.abs(geometry[1].line - geometry[0].line) < 2,
        JSON.stringify({ width, zoom, geometry })
      );
    }
  await frame.locator("body").evaluate((element) => (element.style.zoom = "1"));
  await page.setViewportSize({ width: 1550, height: 1000 });
  const output = path.resolve(
    process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/global-focused"
  );
  fs.mkdirSync(output, { recursive: true });
  await panel.screenshot({ path: path.join(output, `${label}-focused.png`) });
  await guide.click();
  assert.equal((await numbers("before")).length, 82);
  assert.equal((await numbers("after")).length, 82);
  assert.equal(await panel.locator("[data-source-gap]").count(), 0);
  assert.equal(
    await panel
      .locator('[data-current-side="before"] code[data-source-line="1"]')
      .textContent(),
    "\ufeff{\r"
  );
  await panel.screenshot({ path: path.join(output, `${label}-full.png`) });
  assert.deepEqual(
    await panel
      .locator(".git-file-list .changed-file > button")
      .allTextContents(),
    names
  );
  assert.deepEqual(
    await panel
      .locator('.git-file-list .changed-file input[type="checkbox"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: node.getAttribute("aria-label"),
          checked: node.checked,
        }))
      ),
    checks
  );
  // The same enabled display preference follows files, including real padding,
  // all-added source and honest cases where changed raw ranges cannot be proved.
  await guide.click();
  await chooseReviewFile(frame, "unstaged", "focus-insert.ts");
  assert.deepEqual(await numbers("before"), [8, 9, 10, 11, 12, 13]);
  assert.deepEqual(await numbers("after"), [8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(
    await panel.locator('[data-current-side="before"] .diff-padding').count(),
    2
  );
  const aligned = await panel.evaluate((element) =>
    [
      element.querySelector(
        '[data-current-side="before"] code[data-source-line="11"]'
      ),
      element.querySelector(
        '[data-current-side="after"] code[data-source-line="13"]'
      ),
    ].map((node) => node.getBoundingClientRect().y)
  );
  assert.ok(Math.abs(aligned[0] - aligned[1]) < 2);
  await chooseReviewFile(frame, "unstaged", "focus-eof.ts");
  assert.deepEqual(await numbers("after"), [7, 8, 9, 10, 11, 12, 13]);
  assert.equal(
    await panel.locator(".eof-marker").count(),
    0,
    "Do not label an omitted EOF as the end of the displayed excerpt"
  );
  await guide.click();
  assert.equal(await panel.locator(".eof-marker").count(), 2);
  await guide.click();
  await chooseReviewFile(frame, "untracked", "focus-all-new.ts");
  assert.deepEqual(await numbers("after"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(await panel.locator("[data-source-gap]").count(), 0);
  assert.equal(await panel.locator(".eof-marker").count(), 1);
  await chooseReviewFile(frame, "untracked", "focus-empty.ts");
  await panel
    .getByText("No text changes in this source pair.", { exact: true })
    .waitFor();
  assert.equal(await panel.locator("code[data-source-line]").count(), 0);
  await chooseReviewFile(frame, "unstaged", "focus-normalized.txt");
  await panel
    .getByText(
      /Focused sections unavailable; showing available source without guessed alignment/
    )
    .waitFor();
  assert.equal(
    await panel.locator(".diff-added,.diff-removed,[data-source-gap]").count(),
    0
  );
  assert.equal((await numbers("after")).length, 3);
  assert.ok((await guide.getAttribute("class")).includes("selected"));
  await guide.click();
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: guideId }),
    saved
  );
  assert.deepEqual(
    await f.service.call("get_git_viewed", { listId: list.listId }),
    progress
  );
  console.log(
    `PASS ${label} GLOBAL focus on unannotated package.json: literal14/82 rows, two changed windows +3context, explicit unnumbered omissions, exact CRLF/BOM, full restore, parallel6geometry cases, no invented notes/progress/source rebinding.`
  );
}
