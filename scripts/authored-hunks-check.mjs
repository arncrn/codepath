/* global document, getSelection, MouseEvent -- Public browser/native selection. */
import assert from "node:assert/strict";
import { allChanges } from "../tests/fixtures/git-project.mjs";
import { side } from "../tests/fixtures/authored-comparison.mjs";
import {
  chooseReviewFile,
  selectedReviewFile,
} from "./unified-review-check.mjs";

export async function verifyAuthoredHunks(frame, f, label = "browser") {
  const file = "authored-all-hunks.ts";
  const before =
      "const amount = 1;\n" +
      Array.from({ length: 20 }, (_, i) => `// unchanged ${i + 2}`).join("\n") +
      "\nconst tail = 1;\n",
    after = before
      .replace("amount = 1", "amount = 2")
      .replace("tail = 1", "tail = 2");
  f.write(file, before);
  f.git("add", "--", file);
  f.write(file, after);
  const list = await allChanges(f.service),
    entry = list.files.find(
      (item) => item.file === file && item.group === "unstaged"
    ),
    wire = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: entry.id,
    });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "All changes, one explanation",
    listId: list.listId,
    steps: [
      {
        id: "first",
        title: "Explain first change",
        fileId: entry.id,
        binding: wire.binding,
        before: side("Before amount", "Original amount purpose"),
        after: side("After amount", "Updated amount purpose"),
      },
    ],
  });
  if (!(await frame.locator("#current-changes").isVisible()))
    await frame
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
  const controls = frame.locator("#current-changes"),
    panel = selectedReviewFile(frame),
    focus = controls.getByRole("checkbox", {
      name: "Show only changed sections",
      exact: true,
    });
  await focus.uncheck();
  await chooseReviewFile(frame, "unstaged", file);
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  const column = panel.locator('[data-current-side="after"]');
  await column.getByText("Updated amount purpose", { exact: true }).waitFor();
  for (const side of ["before", "after"]) {
    const pane = panel.locator(`[data-current-side="${side}"]`);
    assert.deepEqual(
      await pane
        .locator("code[data-source-line]")
        .evaluateAll((nodes) =>
          nodes.map((node) => Number(node.dataset.sourceLine))
        ),
      [1, 2, 3, 4, 19, 20, 21, 22]
    );
    assert.deepEqual(
      await pane.locator("[data-source-hunk]").allTextContents(),
      ["Lines 1–4", "Lines 19–22"]
    );
  }
  assert.equal(await panel.locator("pre").count(), 2);
  assert.equal(await column.locator("[data-source-gap]").count(), 1);
  await column.locator('code[data-source-line="22"]').evaluate((code) => {
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  assert.equal(
    await column
      .getByRole("button", { name: "Create note", exact: true })
      .count(),
    0,
    "Displaying a second hunk does not enlarge the authored attachment authority"
  );
  await column.locator('code[data-source-line="1"]').evaluate((code) => {
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await column
    .getByRole("button", { name: "Create note", exact: true })
    .click();
  await column.getByLabel("Note text").fill("Current diff exact block note");
  await column.getByRole("button", { name: "Save note", exact: true }).click();
  await column
    .locator(".review-notes .note")
    .filter({ hasText: "Current diff exact block note" })
    .waitFor();
  await column.getByLabel("Note text").waitFor({ state: "detached" });
  let read = await f.service.call("get_comparison_walkthrough", {
      id: saved.id,
    }),
    note = read.steps[0].annotations.notes.find(
      (note) => note.body === "Current diff exact block note"
    );
  assert.equal(note.attachments[0].startLine, 1);
  assert.equal(note.attachments[0].endLine, 1);
  assert.equal(note.side, "after");
  assert.equal(note.binding, wire.binding);
  assert.deepEqual(
    read.steps.map(({ annotations: _annotations, ...step }) => step),
    saved.steps.map(({ annotations: _annotations, ...step }) => step)
  );
  await focus.uncheck();
  assert.equal(
    await panel
      .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
      .count(),
    2,
    "Both Notes homes remain in full-file mode"
  );
  assert.equal(await panel.locator(".optional-explanations").count(), 0);
  assert.equal(await column.locator("code[data-source-line]").count(), 22);
  await column
    .locator(".review-notes .note")
    .filter({ hasText: "Current diff exact block note" })
    .waitFor();
  await column.getByRole("button", { name: "Write note", exact: true }).click();
  await column.getByLabel("Note text").fill("Full file note draft");
  const editor = await column.getByLabel("Note text").elementHandle();
  await focus.check();
  assert.equal(
    await column.getByLabel("Note text").inputValue(),
    "Full file note draft"
  );
  const sameEditor = await column.getByLabel("Note text").elementHandle();
  assert.equal(
    await editor.evaluate((old, now) => old === now, sameEditor),
    true,
    "A source extent toggle must not recreate the editor"
  );
  await focus.uncheck();
  await column.getByRole("button", { name: "Save note", exact: true }).click();
  await column
    .locator(".review-notes .note")
    .filter({ hasText: "Full file note draft" })
    .waitFor();
  await column.getByLabel("Note text").waitFor({ state: "detached" });
  read = await f.service.call("get_comparison_walkthrough", { id: saved.id });
  const fullNote = read.steps[0].annotations.notes.find(
    (note) => note.body === "Full file note draft"
  );
  assert.equal(fullNote.side, "after");
  assert.equal(fullNote.binding, wire.binding);
  assert.deepEqual(fullNote.attachments, []);
  assert.deepEqual(
    read.steps.map(({ annotations: _annotations, ...step }) => step),
    saved.steps.map(({ annotations: _annotations, ...step }) => step)
  );
  // BEFORE/index only changes; AFTER working bytes remain exactly unchanged.
  f.write(file, before.replace("amount = 1", "amount = 99"));
  f.git("add", "--", file);
  f.write(file, after);
  await controls
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await controls
    .locator('.git-file-list[data-inventory-ready="true"]')
    .waitFor();
  await panel
    .locator('[data-current-side="before"] code[data-source-line="1"]')
    .filter({ hasText: "99" })
    .waitFor();
  assert.equal(
    await column.locator('code[data-source-line="1"]').textContent(),
    "const amount = 2;"
  );
  assert.equal(
    await panel
      .locator(
        ".current-annotations .authored-purpose,.current-columns .source-attachment"
      )
      .count(),
    0,
    "Identical AFTER is insufficient: no notes may overlay a mismatching FULL pair"
  );
  await column
    .getByText("Current diff exact block note", { exact: true })
    .waitFor();
  await column.getByText("Full file note draft", { exact: true }).waitFor();
  assert.ok(
    (await column.getByText(/Out of date/).count()) > 0,
    "Mismatch preserves visible explanations, never stale overlays"
  );
  assert.equal(
    await panel.locator("pre").count(),
    2,
    "Only current Before/After source is displayed"
  );
  assert.equal(
    await controls
      .getByRole("button", { name: "Read saved guide source", exact: true })
      .count(),
    0
  );
  assert.equal(
    await controls
      .getByRole("checkbox", { name: `Viewed unstaged ${file}`, exact: true })
      .isChecked(),
    false
  );
  await panel
    .locator('[data-current-side="before"] code[data-source-line="1"]')
    .filter({ hasText: "99" })
    .waitFor();
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    read,
    "Current/historical inspection never rebinds or re-reviews saved explanations"
  );
  console.log(
    `PASS ${label} ALL authored-file hunks with separate range headings; exact editable current note home/range; BEFORE-only mismatch refuses both overlays; full-file Notes/edit/save with same editor/draft across extent toggles; outdated notes remain inline in ONE current display; saved IDs/source/Viewed unchanged.`
  );
}
