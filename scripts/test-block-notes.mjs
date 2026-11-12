import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepath-blocks-"));
const output = path.resolve(
  process.env.CODEPATH_TEST_OUTPUT_DIR ?? ".cache/block-notes"
);
fs.mkdirSync(output, { recursive: true });
const lines = [
  "export function run(value: number) {",
  "  const first = value + 1; // 😀",
  "",
  "  const second = first * 2;",
  "  return second;",
  "}",
  "",
].map((line, index, all) =>
  process.env.CODEPATH_BLOCK_EOL === "crlf" && index < all.length - 1
    ? line + "\r"
    : line
);
fs.writeFileSync(path.join(root, "flow.ts"), lines.join("\n"));
let service, browser, walk;
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  walk = await service.call("save_walkthrough", {
    title: "Block notes",
    steps: [
      {
        id: "run",
        title: "Run",
        source: { file: "flow.ts", symbol: "run" },
        explanation: "Calculate a result.",
      },
      {
        id: "other",
        title: "Another card",
        source: { file: "flow.ts", startLine: 2, endLine: 5 },
        explanation: "Another reading range.",
      },
    ],
  });
  async function review() {
    walk = await service.call("get_walkthrough", { id: walk.id });
    return {
      walkthroughId: walk.id,
      stepId: "run",
      expectedRevision: walk.revision,
      sourceHash: walk.steps[0].code.hash,
      fileHash: walk.steps[0].code.fileHash,
      author: "Fixture",
    };
  }
  await review();
  const range = (start, end) => ({
    file: "flow.ts",
    fileHash: walk.steps[0].code.fileHash,
    startLine: start,
    startColumn: 0,
    endLine: end,
    endColumn: lines[end - 1].length,
    text: lines.slice(start - 1, end).join("\n"),
  });
  const first = await service.call("add_reviewed_note", {
    ...(await review()),
    body: "First block.",
    attachments: [range(2, 4), range(6, 6)],
  });
  const second = await service.call("add_reviewed_note", {
    ...(await review()),
    body: "Overlapping block.",
    attachments: [range(3, 5)],
  });
  const archived = await service.call("add_reviewed_note", {
    ...(await review()),
    body: "Archived block.",
    attachments: [range(2, 5)],
    archived: true,
  });
  const before = fs.readFileSync(
    path.join(root, ".codepaths/workspace.json"),
    "utf8"
  );
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator('.code-card[data-step="run"]').waitFor();
  await page.locator("#notes-tab").click();
  const card = page.locator('.code-card[data-step="run"]');
  const entry = (id) => page.locator(`#notes [data-explanation-id="${id}"]`);
  const markers = (id, line) =>
    page.locator(
      `${line ? `.line:has(code[data-source-line="${line}"]) ` : ""}[data-block-note-id="${id}"]`
    );
  assert.equal(
    await markers(first.id).count(),
    4,
    "All of a note's blocks, including a blank line, need matching source markers."
  );
  assert.equal(await markers(second.id).count(), 3);
  assert.equal(await markers(archived.id).count(), 0);
  const color = (id) =>
    entry(id).evaluate((e) => globalThis.getComputedStyle(e).borderLeftColor);
  assert.notEqual(await color(first.id), await color(second.id));
  for (const id of [first.id, second.id]) {
    const [red, green, blue] = (await color(id)).match(/\d+/g).map(Number);
    assert.ok(
      !(red > green * 1.25 && red > blue * 1.1),
      "Annotation shading must not use deletion red/pink."
    );
  }
  assert.equal(
    await markers(first.id, 3).evaluate(
      (e) => globalThis.getComputedStyle(e).backgroundColor
    ),
    await color(first.id)
  );
  assert.equal(
    await markers(second.id, 3).evaluate(
      (e) => globalThis.getComputedStyle(e).backgroundColor
    ),
    await color(second.id)
  );
  await entry(first.id).getByText("Lines 2–4, 6", { exact: true }).waitFor();
  assert.equal(
    await card.locator('code[data-source-line="4"]').textContent(),
    lines[3]
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
    before
  );
  await page.screenshot({ path: path.join(output, "existing-blocks.png") });

  async function select(startLine, startColumn, endLine, endColumn) {
    await page.locator('.code-card[data-step="run"] pre').evaluate(
      (pre, selection) => {
        function position(line, column) {
          const code = pre.querySelector(`code[data-source-line="${line}"]`);
          const walker = globalThis.document.createTreeWalker(
            code,
            globalThis.NodeFilter.SHOW_TEXT
          );
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (column <= node.textContent.length) return [node, column];
            column -= node.textContent.length;
          }
          return [code, 0];
        }
        const range = globalThis.document.createRange();
        range.setStart(...position(selection.startLine, selection.startColumn));
        range.setEnd(...position(selection.endLine, selection.endColumn));
        globalThis.getSelection().removeAllRanges();
        globalThis.getSelection().addRange(range);
        pre.dispatchEvent(
          new globalThis.MouseEvent("mouseup", { bubbles: true })
        );
      },
      { startLine, startColumn, endLine, endColumn }
    );
  }
  const dragStart = await card
    .locator('code[data-source-line="2"]')
    .boundingBox();
  const dragEnd = await card
    .locator('code[data-source-line="4"]')
    .boundingBox();
  await page.mouse.move(dragStart.x + 32, dragStart.y + dragStart.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x + 60, dragEnd.y + dragEnd.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await page
    .getByRole("button", { name: "Create note", exact: true })
    .click({ timeout: 3000 });
  const editor = page.locator("#notes-panel .annotation-editor");
  await editor.getByText("Lines 2–4", { exact: true }).waitFor();
  assert.equal(
    await editor
      .getByRole("button", {
        name: "Attach selected source range",
        exact: true,
      })
      .count(),
    0
  );
  await editor
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("New colored block.");
  await editor.getByRole("button", { name: "Save note", exact: true }).click();
  await page
    .locator("#notes .note")
    .getByText("New colored block.", { exact: true })
    .waitFor();
  walk = await service.call("get_walkthrough", { id: walk.id });
  const created = walk.steps[0].notes.find(
    (note) => note.body === "New colored block."
  );
  assert.equal(created.attachments.length, 1);
  assert.equal(created.attachments[0].startLine, 2);
  assert.equal(created.attachments[0].startColumn, 0);
  assert.equal(created.attachments[0].endLine, 4);
  assert.equal(created.attachments[0].endColumn, lines[3].length);
  assert.equal(created.attachments[0].text, lines.slice(1, 4).join("\n"));
  assert.equal(await markers(created.id).count(), 3);
  assert.equal(
    await markers(created.id, 3).evaluate(
      (e) => globalThis.getComputedStyle(e).backgroundColor
    ),
    await color(created.id)
  );
  assert.notEqual(await color(created.id), await color(first.id));
  assert.notEqual(await color(created.id), await color(second.id));
  await page.screenshot({ path: path.join(output, "created-block.png") });
  const savedColors = await Promise.all([
    color(first.id),
    color(second.id),
    color(created.id),
  ]);
  await page.reload();
  await entry(created.id).waitFor();
  assert.deepEqual(
    await Promise.all([color(first.id), color(second.id), color(created.id)]),
    savedColors
  );
  assert.deepEqual(
    await card.locator(".code code[data-source-line]").allTextContents(),
    lines
  );

  // Different selected blocks keep independent drafts; returning to one restores
  // its text instead of appending a new attachment to some other draft.
  await page.locator("#note-text").fill("Generic draft survives.");
  await select(2, 0, 3, 0);
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  await editor.getByText("Lines 2", { exact: true }).waitFor();
  await editor
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("Block A draft.");
  await select(4, 0, 4, 10);
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  assert.equal(
    await editor
      .getByRole("textbox", { name: "Note", exact: true })
      .inputValue(),
    ""
  );
  await editor
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("Block B draft.");
  await select(2, 0, 2, 10);
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  assert.equal(
    await editor
      .getByRole("textbox", { name: "Note", exact: true })
      .inputValue(),
    "Block A draft."
  );
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Generic draft survives."
  );
  await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "run",
    body: "Concurrent note.",
    author: "Other",
  });
  await page
    .locator("#notes .note")
    .getByText("Concurrent note.", { exact: true })
    .waitFor();
  const beforeConflict = await service.call("get_walkthrough", { id: walk.id });
  await editor.getByRole("button", { name: "Save note", exact: true }).click();
  await page.locator("#error").filter({ hasText: "Path changed" }).waitFor();
  assert.deepEqual(
    await service.call("get_walkthrough", { id: walk.id }),
    beforeConflict
  );
  assert.equal(
    await editor
      .getByRole("textbox", { name: "Note", exact: true })
      .inputValue(),
    "Block A draft."
  );
  await editor
    .getByRole("button", { name: "Use my edit", exact: true })
    .click();
  await editor.getByRole("button", { name: "Save note", exact: true }).click();
  await page
    .locator("#notes .note")
    .getByText("Block A draft.", { exact: true })
    .waitFor();

  // A selected block is stale after code changes; explicitly selecting current
  // code can repair the draft without silently stamping an old attachment.
  await select(2, 0, 2, 10);
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  await editor
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("Source-sensitive draft.");
  const changedLines = [...lines];
  changedLines[1] = changedLines[1].replace("+ 1", "+ 2");
  fs.writeFileSync(path.join(root, "flow.ts"), changedLines.join("\n"));
  await editor
    .getByText(
      "Select the block again to keep your draft with the current code.",
      { exact: true }
    )
    .waitFor();
  assert.equal(
    await editor
      .getByRole("button", { name: "Use selected block", exact: true })
      .isDisabled(),
    true
  );
  assert.equal(
    await page.locator("[data-block-note-id]").count(),
    0,
    "Changed source must not keep current-looking block markers."
  );
  const beforeStaleSave = fs.readFileSync(
    path.join(root, ".codepaths/workspace.json"),
    "utf8"
  );
  await editor.getByRole("button", { name: "Save note", exact: true }).click();
  await page.locator("#error").filter({ hasText: "Source changed" }).waitFor();
  assert.equal(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
    beforeStaleSave
  );
  await select(2, 0, 2, 10);
  await editor
    .getByRole("button", { name: "Use selected block", exact: true })
    .click();
  assert.equal(
    await editor
      .getByRole("textbox", { name: "Note", exact: true })
      .inputValue(),
    "Source-sensitive draft."
  );
  await editor.getByRole("button", { name: "Save note", exact: true }).click();
  await page
    .locator("#notes .note")
    .getByText("Source-sensitive draft.", { exact: true })
    .waitFor();
  const repaired = (
    await service.call("get_walkthrough", { id: walk.id })
  ).steps[0].notes.find((note) => note.body === "Source-sensitive draft.");
  assert.equal(repaired.attachments[0].text, changedLines[1]);
  assert.equal(await markers(repaired.id).count(), 1);
  assert.equal(await markers(first.id).count(), 0);
  await select(4, 0, 4, 10);
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  assert.equal(
    await editor
      .getByRole("textbox", { name: "Note", exact: true })
      .inputValue(),
    "Block B draft."
  );
  assert.equal(
    await page
      .locator(
        ".source-usages,.review-guards,.note-details,.archived-notes,.card-review"
      )
      .count(),
    0
  );
  const otherCode = page.locator(
    '.code-card[data-step="other"] code[data-source-line="4"]'
  );
  await otherCode.evaluate((code) => {
    const range = globalThis.document.createRange();
    range.selectNodeContents(code);
    globalThis.getSelection().removeAllRanges();
    globalThis.getSelection().addRange(range);
    code.dispatchEvent(new globalThis.MouseEvent("mouseup", { bubbles: true }));
  });
  await page.locator('.code-card.active[data-step="other"]').waitFor();
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  assert.equal(
    await editor
      .getByRole("textbox", { name: "Note", exact: true })
      .inputValue(),
    ""
  );
  await editor
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("Other card block.");
  await editor.getByRole("button", { name: "Save note", exact: true }).click();
  await page
    .locator("#notes .note")
    .getByText("Other card block.", { exact: true })
    .waitFor();
  walk = await service.call("get_walkthrough", { id: walk.id });
  assert.equal(walk.steps[1].notes[0].body, "Other card block.");
  assert.equal(walk.steps[1].notes[0].attachments[0].startLine, 4);
  assert.equal(
    walk.steps[0].notes.some((note) => note.body === "Other card block."),
    false
  );
  await select(4, 0, 4, 10);
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  assert.equal(
    await editor
      .getByRole("textbox", { name: "Note", exact: true })
      .inputValue(),
    "Block B draft."
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS block notes: matching colors, overlapping/multiple/blank-line blocks, archived/stale exclusion, exact UTF-16 source, select → Create note → save, automatic whole-line attachment, reload colors, independent drafts, concurrent-save rejection and explicit source-change recovery."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
