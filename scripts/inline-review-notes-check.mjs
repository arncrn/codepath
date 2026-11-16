import { readVariable } from "./unified-review-check.mjs";
import assert from "node:assert/strict";
import { allChanges } from "../tests/fixtures/git-project.mjs";
import { side } from "../tests/fixtures/authored-comparison.mjs";
import {
  chooseReviewFile,
  selectedReviewFile,
} from "./unified-review-check.mjs";

export async function verifyInlineReviewNotes(frame, f) {
  const path = "inline-review-notes.ts";
  f.write(path, "const amount = 1;\n");
  f.git("add", "--", path);
  f.write(path, "const amount = 2;\n");
  const list = await allChanges(f.service),
    file = list.files.find((f) => f.file === path && f.group === "unstaged"),
    source = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Always visible explanations",
    listId: list.listId,
    steps: ["first", "second"].map((id) => ({
      id,
      title: `Inline ${id}`,
      fileId: file.id,
      binding: source.binding,
      before: side(`Inline ${id} before`, `Original ${id} before purpose`),
      after: side(`Inline ${id} after`, `Original ${id} after purpose`),
    })),
  });
  if (!(await frame.locator("#current-changes").isVisible()))
    await frame
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
  await chooseReviewFile(frame, "unstaged", path);
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  const panel = frame.locator("#current-changes");
  assert.equal(
    await panel
      .getByRole("button", { name: "Read saved guide source", exact: true })
      .count(),
    0,
    "There must be no second source mode"
  );
  const current = selectedReviewFile(frame),
    after = current.locator('[data-current-side="after"]');
  await after
    .getByText("Inline first after block behavior", { exact: true })
    .waitFor();
  await after
    .getByText("Inline second after block behavior", { exact: true })
    .waitFor();
  assert.equal(
    await current.locator("pre").count(),
    2,
    "One actual Before/After source display per file"
  );
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Retained exact-pair draft");
  const editor = await after.getByLabel("Note text").elementHandle();
  const focus = panel.getByRole("checkbox", {
    name: "Show only changed sections",
    exact: true,
  });
  await focus.uncheck();
  assert.equal(
    await editor.evaluate(
      (old, now) => old === now,
      await after.getByLabel("Note text").elementHandle()
    ),
    true
  );
  await panel.getByRole("button", { name: "Compare", exact: true }).click();
  await panel.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  await panel
    .getByRole("button", { name: `Open compare ${path}`, exact: true })
    .waitFor();
  const row = panel.locator(
    `[data-review-path="${path}"]:not([data-review-group="staged"])`
  );
  await row.scrollIntoViewIfNeeded();
  await row.locator('.current-file-body[data-source-state="ready"]').waitFor();
  await row
    .getByText("Inline first after block behavior", { exact: true })
    .waitFor();
  await readVariable(row, "Inline second after named amount");
  assert.ok(
    (await row.getByText(/Out of date/).count()) > 0,
    "Query mismatch labels explanations instead of hiding them"
  );
  assert.equal(
    await row
      .locator(".code .source-attachment,.code [data-block-note-id]")
      .count(),
    0,
    "Never paint old ranges onto another pair"
  );
  assert.equal(
    await row.getByRole("button", { name: "Save note", exact: true }).count(),
    0,
    "No stale editor can submit against current source"
  );
  await panel.getByRole("button", { name: "Changes", exact: true }).click();
  await chooseReviewFile(frame, "unstaged", path);
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Retained exact-pair draft"
  );
  f.write(path, "const amount = 99;\n");
  await panel
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await panel.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  await row
    .getByText("Inline first after block behavior", { exact: true })
    .waitFor();
  await row
    .locator('code[data-source-line="1"]')
    .filter({ hasText: "amount = 99" })
    .waitFor();
  assert.ok((await row.getByText(/Out of date/).count()) > 0);
  assert.equal(
    await row
      .locator(".code .source-attachment,.code [data-block-note-id]")
      .count(),
    0
  );
  await panel.getByRole("button", { name: "Compare", exact: true }).click();
  await panel
    .getByLabel("Current target", { exact: true })
    .selectOption("HEAD");
  await panel
    .getByText("No allowed-path differences.", { exact: true })
    .waitFor();
  const orphan = panel.locator('[data-unmatched-explanation="first"]');
  await orphan.scrollIntoViewIfNeeded();
  await orphan
    .getByText("Inline first after block behavior", { exact: true })
    .waitFor();
  await readVariable(orphan, "Inline first after named amount");
  assert.equal(
    await panel.locator("pre").count(),
    0,
    "Do not substitute original source when current comparison is empty"
  );
  assert.equal(await panel.locator(".changed-file input:checked").count(), 0);
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved,
    "Displaying original explanations never rebinds, restamps or reviews them"
  );
  console.log(
    "PASS inline Notes/Variables, all authored steps, no saved-source mode, exact editor/draft restored; query/byte/empty mismatches remain visible but never highlight or edit wrong code."
  );
  return { saved, path };
}
