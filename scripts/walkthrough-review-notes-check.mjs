/* global innerHeight, innerWidth, getComputedStyle -- viewport geometry inside DOM callbacks. */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  chooseReviewFile,
  selectedReviewFile,
} from "./unified-review-check.mjs";

export async function verifyWalkthroughReviewNotes(frame, f) {
  const previousPath = (await frame.locator("[data-path].selected").count())
    ? await frame.locator("[data-path].selected").getAttribute("data-path")
    : null;
  const previousStep = (await frame.locator(".code-card.active").count())
    ? await frame.locator(".code-card.active").getAttribute("data-step")
    : null;
  const file = "walkthrough-review-notes.ts";
  f.write(file, "const amount = 1;\nconsole.log(amount);\n");
  f.git("add", "--", file);
  f.write(file, "const amount = 2;\nconsole.log(amount);\n");
  let walk = await f.service.call("save_walkthrough", {
    title: "Shared walkthrough annotations",
    steps: [
      {
        id: "shared-card",
        title: "The actual walkthrough card",
        source: { file, startLine: 1, endLine: 2 },
        explanation: "Purpose from the actual walkthrough",
      },
    ],
  });
  const add = async (body, variable = false) => {
    walk = await f.service.call("get_walkthrough", { id: walk.id });
    const code = walk.steps[0].code;
    const range = {
      file,
      fileHash: code.fileHash,
      startLine: 1,
      endLine: 1,
      startColumn: variable ? 6 : 0,
      endColumn: variable ? 12 : code.lines[0].length,
      text: variable ? "amount" : code.lines[0],
    };
    return f.service.call("add_reviewed_note", {
      walkthroughId: walk.id,
      stepId: "shared-card",
      expectedRevision: walk.revision,
      sourceHash: code.hash,
      fileHash: code.fileHash,
      body,
      author: "Human",
      attachments: [range],
      ...(variable ? { variableName: "amount" } : {}),
    });
  };
  const block = await add("The existing walkthrough block note."),
    variable = await add("The existing walkthrough variable meaning.", true);
  await frame.locator(`[data-path="${walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${walk.id}"]`).click();
  await frame.locator("#notes-tab").click();
  await frame
    .locator("#notes")
    .getByText(block.body, { exact: true })
    .waitFor();
  const normalNotesTab = await tabStyle(frame.locator("#notes-tab"));
  const normalBlock = await signature(
    frame.locator('#notes [data-explanation-id="' + block.id + '"]')
  );
  await frame.locator("#variables-tab").click();
  const normalVariablesTab = await tabStyle(frame.locator("#variables-tab"));
  const normalVariable = await signature(
    frame.locator('#variables [data-explanation-id="' + variable.id + '"]')
  );
  await frame.locator("#notes-tab").click();
  await frame.locator("#note-text").fill("Ordinary draft must survive review");
  await frame
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await frame
    .locator("#current-changes")
    .getByRole("button", { name: "Changes", exact: true })
    .click();
  const review = frame.locator("#current-changes");
  await review.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  // Do not choose/scroll to the file or note first: that masked the user's bug.
  const deadline = Date.now() + 6000;
  let visible;
  do {
    visible = await review.evaluate(
      (root, ids) => {
        const clip = root.getBoundingClientRect();
        return ids.every((id) => {
          const node = root.querySelector(
            `[data-walkthrough-note-id="${id}"] .markdown-body`
          );
          if (!node) return false;
          const r = node.getBoundingClientRect();
          const pane =
            node
              .closest(".review-annotation-scroll")
              ?.getBoundingClientRect() ?? clip;
          return (
            r.width > 0 &&
            r.height > 0 &&
            r.top >= Math.max(0, clip.top, pane.top) &&
            r.bottom <= Math.min(innerHeight, clip.bottom, pane.bottom) &&
            r.right > Math.max(0, clip.left) &&
            r.left < Math.min(innerWidth, clip.right)
          );
        });
      },
      [block.id]
    );
    if (!visible) await new Promise((resolve) => setTimeout(resolve, 100));
  } while (!visible && Date.now() < deadline);
  if (!visible)
    console.log(
      "Notes visibility geometry",
      JSON.stringify(
        await review.evaluate(
          (root, ids) => ({
            viewport: [innerWidth, innerHeight],
            root: root.getBoundingClientRect().toJSON(),
            scrollTop: root.scrollTop,
            active: [...root.querySelectorAll("[data-review-active=true]")].map(
              (n) => n.getAttribute("data-review-path")
            ),
            entries: ids.map((id) => {
              const n = root.querySelector(
                `[data-walkthrough-note-id="${id}"] .markdown-body`
              );
              return {
                id,
                box: n?.getBoundingClientRect().toJSON(),
                clip: n
                  ?.closest(".review-annotation-scroll")
                  ?.getBoundingClientRect()
                  .toJSON(),
              };
            }),
          }),
          [block.id, variable.id]
        )
      )
    );
  assert.equal(
    visible,
    true,
    "On review entry the actual Note must be visible without EOF scrolling; Variables uses the same explicit tab as ordinary reading"
  );
  assert.equal(
    await review.locator("nav.comparison-steps").count(),
    0,
    "No misleading example-step button strip"
  );
  console.log(
    "PASS on-entry Note visible; Variables explicitly accessible in the shared tab format, no EOF scroll or example-step strip."
  );
  await chooseReviewFile(frame, "unstaged", file);
  const panel = frame.locator("#current-changes"),
    current = selectedReviewFile(frame);
  const entry = current.locator(`[data-walkthrough-note-id="${block.id}"]`),
    vars = current.locator(`[data-walkthrough-note-id="${variable.id}"]`);
  await entry.getByText(block.body, { exact: true }).waitFor();
  const card = current.locator('[data-walkthrough-card="shared-card"]');
  assert.deepEqual(
    await tabStyle(
      card.getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
    ),
    normalNotesTab,
    "Same tab styling, not arrow-control button styling"
  );
  assert.deepEqual(
    await signature(entry),
    normalBlock,
    "Same actual Notes presentation, not a review-specific layout"
  );
  await card
    .getByRole("button", { name: /^Variables(?: · \d+)?$/, exact: true })
    .click();
  await vars.getByText(variable.body, { exact: true }).waitFor();
  assert.deepEqual(
    await tabStyle(
      card.getByRole("button", { name: /^Variables(?: · \d+)?$/, exact: true })
    ),
    normalVariablesTab
  );
  assert.deepEqual(
    await signature(vars),
    normalVariable,
    "Same actual Variable presentation"
  );
  await card
    .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
    .click();
  assert.equal(
    await vars.locator("h3 > code").count(),
    1,
    "Review must reuse the walkthrough Variable heading, not its own strong-label format"
  );
  assert.equal(
    await entry.locator(".block-note-location").count(),
    1,
    "Review must reuse the walkthrough attached-note line label"
  );
  assert.equal(
    await entry.count(),
    1,
    "Same original note ID, not a copied comparison annotation"
  );
  assert.equal(await entry.getAttribute("data-note-source-status"), "current");
  assert.equal(await vars.getAttribute("data-note-source-status"), "current");
  assert.equal(
    await current
      .locator('[data-current-side="before"] [data-walkthrough-note-id]')
      .count(),
    0,
    "Do not place working-version notes on another BEFORE version"
  );
  assert.equal(await current.locator("pre").count(), 2);
  // Change the actual ordinary note through its own API/revision. Review must
  // observe the same ID/body, not a copied or comparison-owned record.
  const owner = await f.service.call("get_walkthrough", { id: walk.id });
  await f.service.call("review_note", {
    walkthroughId: walk.id,
    stepId: "shared-card",
    noteId: block.id,
    expectedRevision: owner.revision,
    sourceHash: owner.steps[0].code.hash,
    fileHash: owner.steps[0].code.fileHash,
    attachments: block.attachments,
    body: "Revised actual walkthrough note.",
    author: "Human",
  });
  block.body = "Revised actual walkthrough note.";
  await entry.getByText(block.body, { exact: true }).waitFor();
  await chooseReviewFile(frame, "staged", file);
  await entry.getByText(block.body, { exact: true }).waitFor();
  assert.equal(
    await entry.getAttribute("data-note-source-status"),
    "outdated",
    "Same path alone is not exact source correspondence"
  );
  f.write(file, "const amount = 99;\nconsole.log(amount);\n");
  await panel
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await chooseReviewFile(frame, "unstaged", file);
  await current
    .locator('[data-current-side="after"] code[data-source-line="1"]')
    .filter({ hasText: "99" })
    .waitFor();
  await entry.getByText(block.body, { exact: true }).waitFor();
  assert.equal(await entry.getAttribute("data-note-source-status"), "outdated");
  assert.equal(await vars.getAttribute("data-note-source-status"), "outdated");
  await panel.getByRole("button", { name: "Compare", exact: true }).click();
  await panel
    .getByLabel("Current target", { exact: true })
    .selectOption("HEAD");
  await panel
    .getByText("No allowed-path differences.", { exact: true })
    .waitFor();
  const orphan = panel.locator('[data-unmatched-walkthrough="shared-card"]');
  await orphan.scrollIntoViewIfNeeded();
  await orphan.getByText(block.body, { exact: true }).waitFor();
  await orphan
    .getByRole("button", { name: /^Variables(?: · \d+)?$/, exact: true })
    .click();
  await orphan.getByText(variable.body, { exact: true }).waitFor();
  await orphan
    .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
    .click();
  assert.equal(await panel.locator("pre").count(), 0);
  assert.equal(
    await panel
      .getByRole("button", { name: "Read saved guide source", exact: true })
      .count(),
    0
  );
  // f is always the owned disposable browser/native fixture, never live QA.
  const root = f.git("rev-parse", "--show-toplevel").toString().trim();
  const parked = root + ".git-walkthrough-notes-qa";
  assert.equal(fs.existsSync(parked), false);
  fs.renameSync(root + "/.git", parked);
  try {
    await panel
      .getByRole("button", { name: "Refresh changes", exact: true })
      .click();
    await panel
      .getByRole("alert")
      .filter({ hasText: "Coverage is incomplete/unknown." })
      .waitFor();
    await orphan.scrollIntoViewIfNeeded();
    await orphan.getByText(block.body, { exact: true }).waitFor();
    await orphan
      .getByRole("button", { name: /^Variables(?: · \d+)?$/, exact: true })
      .click();
    await orphan.getByText(variable.body, { exact: true }).waitFor();
    await orphan
      .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
      .click();
    assert.equal(
      await orphan
        .locator(`[data-walkthrough-note-id="${block.id}"]`)
        .getAttribute("data-note-source-status"),
      "unverified"
    );
    assert.equal(await panel.locator("pre").count(), 0);
  } finally {
    fs.renameSync(parked, root + "/.git");
  }
  const saved = await f.service.call("get_walkthrough", { id: walk.id });
  assert.ok(
    saved.steps[0].notes.some((n) => n.id === block.id && n.body === block.body)
  );
  assert.ok(
    saved.steps[0].notes.some(
      (n) => n.id === variable.id && n.body === variable.body
    )
  );
  assert.equal(await panel.locator(".changed-file input:checked").count(), 0);
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Ordinary draft must survive review"
  );
  if (previousPath) {
    await frame.locator(`[data-path="${previousPath}"]`).click();
    if (previousStep)
      await frame.locator(`[data-select="${previousStep}"]`).click();
  }
  console.log(
    "PASS SAME walkthrough note/Variable IDs in review, correct AFTER version, stale same-path text retained, empty comparison preserved, no duplicate authoring or Viewed/focus/draft loss."
  );
  return { id: walk.id, file, block, variable };
}

async function tabStyle(button) {
  return button.evaluate((n) => {
    const s = getComputedStyle(n);
    return {
      font: s.fontSize,
      background: s.backgroundColor,
      padding: s.padding,
      height: s.height,
      border: s.borderBottom,
    };
  });
}
async function signature(entry) {
  return entry.evaluate((n) => ({
    className: n.className,
    location: n.querySelector(".block-note-location")?.textContent ?? null,
    variable: n.querySelector("h3>code")?.textContent ?? null,
    variableLine: n.querySelector(".variable-location")?.textContent ?? null,
    markdown: n.querySelector(".markdown-body")?.innerHTML,
    background: n.style.backgroundColor,
    bodyFont: getComputedStyle(n.querySelector(".markdown-body")).fontSize,
  }));
}
