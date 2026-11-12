/* global document, getSelection, getComputedStyle, MouseEvent -- Native DOM callbacks. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { callTool } from "../dist/client.mjs";
import { gitEnvironment, allChanges } from "../tests/fixtures/git-project.mjs";
import { verifyGlobalFocus } from "./global-focused-check.mjs";
import { verifyAuthoredHunks } from "./authored-hunks-check.mjs";
import { verifyComposedReview } from "./composed-review-check.mjs";
import { verifyCoverage, verifyGuideToggle } from "./review-coverage-check.mjs";
import {
  chooseReviewFile,
  readSavedStep,
  assertParallel,
} from "./unified-review-check.mjs";

// Only test-vscode's owned disposable project/profile/extension host.
export async function verifyNativeGit(frame, root) {
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
  const git = (...args) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      { env: gitEnvironment, stdio: "pipe" }
    );
  git("init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ".codepaths/\na-unrelated/\nflow.ts\nstore.ts\nauthoring.ts\ngo/\n"
  );
  fs.writeFileSync(path.join(root, "native-git.ts"), "const value = 1;\n");
  git("add", "--", ".gitignore", "native-git.ts");
  git("commit", "--quiet", "-m", "native fixture");
  git("branch", "equal");
  fs.writeFileSync(path.join(root, "native-git.ts"), "const value = 2;\n");
  git("add", "--", "native-git.ts");
  fs.writeFileSync(
    path.join(root, "native-git.ts"),
    "const value = 3;\nconsole.log(value);\n"
  );
  const service = { call: (name, args) => callTool(root, name, args) },
    list = await allChanges(service);
  const authoredSide = (title, purpose, endLine = 1) => ({
    title,
    purpose,
    startLine: 1,
    endLine,
    notes: [{ body: title + " block", startLine: 1, endLine }],
    variables: [
      {
        name: "value",
        body: title + " named value",
        occurrences: [{ line: 1, startColumn: 6 }],
      },
    ],
  });
  const steps = [];
  for (const group of ["staged", "unstaged"]) {
    const file = list.files.find(
      (file) => file.file === "native-git.ts" && file.group === group
    );
    const source = await service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
    steps.push({
      id: group,
      title:
        group === "staged" ? "Stage the constant" : "Report the saved value",
      fileId: file.id,
      binding: source.binding,
      before: authoredSide(group + " before", "Use the earlier exact source."),
      after: authoredSide(
        group + " after",
        group === "staged"
          ? "Use the staged constant."
          : "Report the saved working value.",
        group === "unstaged" ? 2 : 1
      ),
    });
  }
  const saved = await service.call("create_comparison_walkthrough", {
    title: "Native paired walkthrough",
    listId: list.listId,
    steps,
  });
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  const panel = frame.locator("#current-changes"),
    left = panel.locator('[data-git-side="before"]'),
    right = panel.locator('[data-git-side="after"]');
  await panel.locator(".guide-display pre").first().waitFor();
  const inventory = await panel.locator(".git-file-list").elementHandle();
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  await chooseReviewFile(frame, "staged", "native-git.ts");
  assert.equal(await panel.locator(".current-columns pre").count(), 2);
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  await panel.locator(".guide-display pre").first().waitFor();
  assert.equal(await panel.locator(".current-columns").count(), 1);
  const currentInventory = await panel
    .locator(".git-file-list")
    .elementHandle();
  assert.equal(
    await inventory.evaluate((old, now) => old === now, currentInventory),
    true
  );
  for (const [group, before, after, additions] of [
    ["staged", "1", "2", 1],
    ["unstaged", "2", "3", 2],
  ]) {
    await readSavedStep(
      frame,
      group === "staged" ? "Stage the constant" : "Report the saved value"
    );
    await right
      .getByRole("heading", { name: group + " after", exact: true })
      .waitFor();
    assert.equal(
      await panel.locator("pre").count(),
      2,
      "Guide adds no alternate source panes"
    );
    assert.equal(
      await left.locator("code[data-source-line]").first().innerText(),
      `const value = ${before};`
    );
    assert.equal(
      await right.locator("code[data-source-line]").first().innerText(),
      `const value = ${after};`
    );
    assert.equal(await left.locator(".diff-removed").count(), 1);
    assert.equal(await right.locator(".diff-added").count(), additions);
    await assertParallel(frame, panel.locator(".walkthrough-columns"));
  }
  const theme = await panel
    .locator('[data-comparison-column="before"] .authored-card')
    .evaluate((e) => ({
      card: getComputedStyle(e).backgroundColor,
      host: getComputedStyle(document.documentElement).backgroundColor,
    }));
  assert.equal(
    theme.card,
    theme.host,
    "Current cards must use the native editor theme"
  );
  assert.equal(await panel.locator("[data-reference]").count(), 0);
  const after = right;
  await after.locator('code[data-source-line="1"]').evaluate((code) => {
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await after.getByRole("button", { name: "Create note", exact: true }).click();
  await after.getByLabel("Note text").fill("Native comparison attachment");
  await after.getByRole("button", { name: "Save note", exact: true }).click();
  const note = after
    .locator(".review-notes .note")
    .filter({ hasText: "Native comparison attachment" });
  await note.waitFor();
  const read = await service.call("get_comparison_walkthrough", {
      id: saved.id,
    }),
    human = read.steps[1].annotations.notes.find(
      (n) => n.body === "Native comparison attachment"
    );
  assert.equal(human.side, "after");
  assert.equal(human.attachments[0].text, "const value = 3;");
  const marker = after.locator(`[data-block-note-id="${human.id}"]`);
  assert.equal(await marker.count(), 1);
  assert.equal(
    await marker.evaluate((e) => getComputedStyle(e).backgroundColor),
    await note.evaluate((e) => getComputedStyle(e).borderLeftColor)
  );
  await note.getByRole("button", { name: "Edit", exact: true }).click();
  await after.getByLabel("Note text").fill("Edited native attachment");
  await after.getByRole("button", { name: "Save note", exact: true }).click();
  const edited = after
    .locator(".note")
    .filter({ hasText: "Edited native attachment" });
  await edited.waitFor();
  await edited
    .getByRole("button", { name: "Delete note", exact: true })
    .click();
  await edited
    .getByRole("button", { name: "Confirm delete note", exact: true })
    .click();
  await edited.waitFor({ state: "detached" });
  const history = (
    await service.call("get_comparison_walkthrough", { id: saved.id })
  ).steps[1].annotations.notes.find((n) => n.id === human.id);
  assert.equal(history.archived, true);
  assert.equal(history.history.length, 2);
  await after.getByRole("button", { name: "Variables", exact: true }).click();
  await after
    .getByText("unstaged after named value", { exact: true })
    .waitFor();
  await after.locator(".source-attachment").first().focus();
  await frame.page().keyboard.press("Space");
  assert.equal(await frame.locator("#modal:visible").count(), 0);
  const screenshots = path.resolve(
    process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/comparison-walkthrough"
  );
  fs.mkdirSync(screenshots, { recursive: true });
  await panel.screenshot({
    path: path.join(screenshots, "unified-native-matched.png"),
  });
  await panel.getByRole("button", { name: "Compare", exact: true }).click();
  await panel.getByLabel("Current base branch").selectOption("refs/heads/main");
  await panel
    .getByLabel("Current target", { exact: true })
    .selectOption("refs/heads/equal");
  await panel
    .getByText("No allowed-path differences.", { exact: true })
    .waitFor();
  assert.equal(
    await panel.locator(".current-columns").count(),
    0,
    "Equal current choices do not display unrelated saved code"
  );
  await panel.getByText(/different comparison choices/).waitFor();
  await readSavedStep(frame, "Stage the constant");
  assert.equal(
    await panel
      .locator('.saved-versions [data-git-side="after"] code[data-source-line]')
      .first()
      .innerText(),
    "const value = 2;"
  );
  for (const forbidden of [
    "Capture review",
    "Review identity",
    "Check live status",
    "Snapshot provenance",
    "Repair source reference",
  ])
    assert.ok(!(await panel.innerText()).includes(forbidden));
  assert.equal(
    await frame.evaluate(() => globalThis.CODEPATH_TOKEN),
    undefined
  );
  assert.match(
    await frame
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content"),
    /connect-src 'none'/
  );
  await panel.screenshot({
    path: path.join(screenshots, "unified-native.png"),
  });
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  const fixture = {
    service,
    git,
    write: (file, text) => fs.writeFileSync(path.join(root, file), text),
  };
  await verifyComposedReview(frame, fixture, "native");
  await verifyCoverage(frame, fixture, "native");
  await verifyGuideToggle(frame, fixture, "native");
  await verifyGlobalFocus(frame, fixture, saved.id, "native");
  await verifyAuthoredHunks(frame, fixture, "native");
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  console.log(
    "PASS native unified review: restricted CSP/host transport, full paired sources/geometry, independent purposes/Notes/Variables, annotation edit/delete/history/palette, real comparison choices and explicit saved access."
  );
}
