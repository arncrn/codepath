import { readVariable } from "./unified-review-check.mjs";
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
import { verifyReviewNavigation } from "./check-review-navigation.mjs";
import { verifyFileStream } from "./check-file-stream.mjs";
import { verifyInlineReviewNotes } from "./inline-review-notes-check.mjs";
import { verifyWalkthroughReviewNotes } from "./walkthrough-review-notes-check.mjs";
import { verifySingleReviewSource } from "./single-review-source-check.mjs";
import { verifyReviewFlow } from "./review-flow-check.mjs";
import { verifyReviewComparisonFlow } from "./review-comparison-flow-check.mjs";
import { verifyAfterFlow } from "./after-flow-check.mjs";
import { verifyFlowChangeColours } from "./flow-change-colours-check.mjs";
import { verifyRefresh } from "./refresh-check.mjs";
import { verifyNoDataUi } from "./no-data-ui-check.mjs";
import { verifyCoverage, verifyGuideToggle } from "./review-coverage-check.mjs";
import {
  chooseReviewFile,
  selectedReviewFile,
  readReviewStep,
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
  const service = { call: (name, args) => callTool(root, name, args) };
  if (process.env.CODEPATH_TEST_NO_DATA_ONLY === "1") {
    await verifyNoDataUi(frame, {
      root,
      service,
      git,
      write: (file, text) => fs.writeFileSync(path.join(root, file), text),
    });
    return;
  }
  if (process.env.CODEPATH_TEST_REFRESH_ONLY === "1") {
    await verifyRefresh(frame, {
      service,
      git,
      write: (file, text) => fs.writeFileSync(path.join(root, file), text),
    });
    return;
  }
  if (process.env.CODEPATH_TEST_FLOW_COLOURS_ONLY === "1") {
    await verifyFlowChangeColours(frame, {
      service,
      git,
      write: (file, text) => fs.writeFileSync(path.join(root, file), text),
    });
    return;
  }
  const list = await allChanges(service);
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
  const controls = frame.locator("#current-changes"),
    panel = selectedReviewFile(frame),
    left = panel.locator('[data-current-side="before"]'),
    right = panel.locator('[data-current-side="after"]');
  // Review entry now reveals the ordinary card's Notes, which may be outside
  // this comparison. This scenario explicitly tests native-git.ts instead.
  await chooseReviewFile(frame, "staged", "native-git.ts");
  await panel.locator(".guide-display pre").first().waitFor();
  const inventory = await controls.locator(".git-file-list").elementHandle();
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  await chooseReviewFile(frame, "staged", "native-git.ts");
  assert.equal(await panel.locator(".current-columns pre").count(), 2);
  await verifyFileStream(frame);
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  await panel.locator(".guide-display pre").first().waitFor();
  assert.equal(await panel.locator(".current-columns").count(), 1);
  const currentInventory = await controls
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
    await readReviewStep(
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
    await assertParallel(frame, panel.locator(".current-columns"));
  }
  await verifyFileStream(frame);
  const theme = await panel
    .locator('[data-current-side="before"] .current-file-card')
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
  await verifyReviewNavigation(frame);
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
  await after
    .getByRole("button", { name: /^Variables(?: · \d+)?$/, exact: true })
    .click();
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
  await controls.getByRole("button", { name: "Compare", exact: true }).click();
  await controls
    .getByLabel("Current base branch")
    .selectOption("refs/heads/main");
  await controls
    .getByLabel("Current target", { exact: true })
    .selectOption("refs/heads/equal");
  await controls
    .getByText("No allowed-path differences.", { exact: true })
    .waitFor();
  assert.equal(
    await panel.locator(".current-columns").count(),
    0,
    "Equal current choices do not display unrelated saved code"
  );
  assert.equal(
    await controls
      .getByText("Saved guide uses different comparison choices.", {
        exact: true,
      })
      .count(),
    0,
    "Requested status omitted; unrelated saved code is still refused"
  );
  await readReviewStep(frame, "Stage the constant");
  await panel.getByText("staged after block", { exact: true }).waitFor();
  await readVariable(panel, "staged after named value");
  assert.equal(
    await controls.locator("pre").count(),
    0,
    "Equal choices retain explanations, not a second saved code display"
  );
  assert.ok((await panel.getByText(/Out of date/).count()) > 0);
  for (const forbidden of [
    "Capture review",
    "Review identity",
    "Check live status",
    "Snapshot provenance",
    "Repair source reference",
  ])
    assert.ok(!(await controls.innerText()).includes(forbidden));
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
  await verifyInlineReviewNotes(frame, fixture);
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  await verifyWalkthroughReviewNotes(frame, fixture);
  await verifySingleReviewSource(frame, fixture);
  await verifyReviewFlow(frame, fixture);
  await verifyReviewComparisonFlow(frame, fixture);
  await verifyAfterFlow(frame, fixture);
  console.log(
    "PASS native unified review: restricted CSP/host transport, full paired sources/geometry, independent purposes/Notes/Variables, annotation edit/delete/history/palette, real comparison choices and always-inline outdated explanations."
  );
}
