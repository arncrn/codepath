import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
const artifacts =
  process.env.CODEPATH_TEST_OUTPUT_DIR ||
  path.join(base, ".cache/function-context");
fs.mkdirSync(artifacts, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-context-browser-"));
const source = [
  "function first() {",
  "  function same() {",
  "    return 1;",
  "  }",
  "  items.map((item) => {",
  "    return item;",
  "  });",
  "}",
  "function second() {",
  "  function same() {",
  "    return 2;",
  "  }",
  "}",
  "console.log('top level');",
].join("\n");
fs.writeFileSync(path.join(root, "flow.tsx"), source);
fs.writeFileSync(
  path.join(root, "main.go"),
  "package main\nfunc (r *Reader) Read() {\n  println(r)\n}\n"
);
fs.writeFileSync(
  path.join(root, "callback.go"),
  "package main\nfunc run() {\n  callback := func() {\n    println(1)\n  }\n  callback()\n}\n"
);
fs.writeFileSync(
  path.join(root, "broken.go"),
  "package main\nfunc run() {\n  callback := func() {\n    println(1)\n"
);
fs.writeFileSync(
  path.join(root, "generic.go"),
  "package main\ntype Store[T any] struct{ Value T }\nfunc (s *Store[T]) Load() T {\n  return s.Value\n}\n"
);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.join(base, "dist"),
  });
  const walk = await service.call("save_walkthrough", {
    id: "function-context",
    title: "Function context fixture",
    steps: [
      ["nested", "flow.tsx", 3, 3],
      ["anonymous", "flow.tsx", 6, 6],
      ["same-name", "flow.tsx", 11, 11],
      ["mixed", "flow.tsx", 3, 6],
      ["whole", "flow.tsx", 1, 8],
      ["siblings", "flow.tsx", 3, 11],
      ["top", "flow.tsx", 14, 14],
      ["go", "main.go", 3, 3],
      ["go-callback", "callback.go", 4, 4],
      ["go-outer", "callback.go", 6, 6],
      ["go-generic", "generic.go", 4, 4],
      ["unsupported", "broken.go", 4, 4],
    ].map(([id, file, startLine, endLine]) => ({
      id,
      title: "Purpose is not a function name",
      explanation: "Keep this card purpose.",
      source: { file, startLine, endLine },
    })),
  });
  await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "nested",
    author: "Reader",
    body: "Keep the saved note.",
  });
  const current = await service.call("get_walkthrough", { id: walk.id });
  const nested = current.steps.find((step) => step.id === "nested");
  const block = await service.call("add_reviewed_note", {
    walkthroughId: walk.id,
    stepId: "nested",
    expectedRevision: current.revision,
    sourceHash: nested.code.hash,
    fileHash: nested.code.fileHash,
    author: "Fixture",
    body: "Keep the attached block.",
    attachments: [
      {
        file: "flow.tsx",
        fileHash: nested.code.fileHash,
        startLine: 3,
        startColumn: 0,
        endLine: 3,
        endColumn: 13,
        text: "    return 1;",
      },
    ],
  });
  const beforeReads = await service.call("get_walkthrough", { id: walk.id });
  const disk = path.join(root, ".codepaths/workspace.json");
  const saved = fs.readFileSync(disk, "utf8");
  const savedMtime = fs.statSync(disk).mtimeMs;
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
  const card = (id) => page.locator(`.code-card[data-step="${id}"]`);
  await card("nested").waitFor();
  await card("nested").locator(".function-context").waitFor({ timeout: 5000 });
  assert.equal(
    await card("nested").locator(".code > .function-context").count(),
    1,
    "the visible function name belongs INSIDE the code pane, not above the card header"
  );
  const expected = {
    nested: "first › same",
    anonymous: "first › anonymous",
    "same-name": "second › same",
    mixed: "first",
    whole: "first",
    siblings: "Multiple functions",
    top: "No enclosing function",
    go: "Reader.Read",
    "go-callback": "run › anonymous",
    "go-outer": "run",
    "go-generic": "Store.Load",
    unsupported: "Unknown function",
  };
  for (const [id, text] of Object.entries(expected)) {
    assert.equal(
      await card(id).locator(".function-context").textContent(),
      text
    );
    assert.equal(
      await card(id).locator(".code > .function-context").textContent(),
      text
    );
    assert.equal(
      await card(id).locator("h3").textContent(),
      "Purpose is not a function name"
    );
    assert.equal(
      await card(id).locator(".reason p").textContent(),
      "Keep this card purpose."
    );
  }
  await page.locator('[data-select="nested"]').click();
  await page.locator("#notes-tab").click();
  // The label is UI chrome, never an extra source line or part of a selection.
  for (const full of [false, true]) {
    if (full)
      await card("nested")
        .getByRole("button", { name: "Full file", exact: true })
        .click();
    const pane = card("nested").locator(".code");
    await pane.locator(".function-context").waitFor({ state: "visible" });
    assert.equal(await pane.locator("pre .function-context").count(), 0);
    assert.equal(
      await pane.locator("code[data-source-line]").count(),
      full ? 14 : 5
    );
    const displayed = await pane
      .locator("code[data-source-line]")
      .evaluateAll((codes) =>
        codes.map((code) => [Number(code.dataset.sourceLine), code.textContent])
      );
    for (const [line, text] of displayed)
      assert.equal(text, source.split("\n")[line - 1]);
    assert.deepEqual(await pane.locator(".line.focus code").allTextContents(), [
      "    return 1;",
    ]);
    assert.equal((await pane.locator(".syntax-keyword").count()) > 0, true);
    assert.equal(
      await pane.locator(`[data-block-note-id="${block.id}"]`).count(),
      1
    );
    const marker = pane.locator(`[data-block-note-id="${block.id}"]`);
    assert.equal(
      await marker.evaluate(
        (element) => globalThis.getComputedStyle(element).backgroundColor
      ),
      await page
        .locator(`#notes [data-explanation-id="${block.id}"]`)
        .evaluate(
          (element) => globalThis.getComputedStyle(element).borderLeftColor
        )
    );
    await pane.locator('code[data-source-line="3"]').evaluate((code) => {
      const range = globalThis.document.createRange();
      range.selectNodeContents(code);
      globalThis.getSelection().removeAllRanges();
      globalThis.getSelection().addRange(range);
      code.dispatchEvent(
        new globalThis.MouseEvent("mouseup", { bubbles: true })
      );
    });
    assert.equal(
      await page.evaluate(() => globalThis.getSelection().toString()),
      "    return 1;"
    );
    await card("nested")
      .locator(".block-selection-actions")
      .getByText("Lines 3", { exact: true })
      .waitFor();
  }
  await card("nested")
    .getByRole("button", { name: "Focus range", exact: true })
    .click();
  const afterReads = await service.call("get_walkthrough", { id: walk.id });
  assert.deepEqual(
    afterReads,
    beforeReads,
    "viewing and selecting must not alter source hashes, references, notes, or revision"
  );
  await page
    .locator("#note-text")
    .fill("Unfinished ordinary draft must survive context refresh.");
  // Changing only the outer declaration preserves the selected source hash,
  // but context must use newly parsed source, not a stored symbol/title.
  fs.writeFileSync(
    path.join(root, "flow.tsx"),
    source.replace("function first()", "function renamed()")
  );
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(
        '[data-step="nested"] .function-context'
      )?.textContent === "renamed › same"
  );
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Unfinished ordinary draft must survive context refresh."
  );
  await page
    .locator("#notes")
    .getByText("Keep the saved note.", { exact: true })
    .waitFor();
  fs.writeFileSync(
    path.join(root, "flow.tsx"),
    source
      .replace("function first()", "function current()")
      .replace("return 1;", "return 9;")
  );
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(
        '[data-step="nested"] code[data-source-line="3"]'
      )?.textContent === "    return 9;"
  );
  assert.equal(
    await card("nested").locator(".function-context").textContent(),
    "current › same"
  );
  await card("nested")
    .locator(".card-title .warning")
    .getByText("Source changed", { exact: true })
    .waitFor();
  assert.equal(
    await card("nested").locator(`[data-block-note-id="${block.id}"]`).count(),
    0,
    "stale attachments must not silently reattach"
  );
  assert.equal(
    await card("nested")
      .getByRole("button", { name: "Repair source reference", exact: true })
      .count(),
    1
  );
  const stale = await service.call("get_walkthrough", { id: walk.id });
  assert.equal(stale.steps[0].snapshotHash, nested.snapshotHash);
  assert.deepEqual(stale.steps[0].source, nested.source);
  assert.equal(
    stale.steps[0].notes.find((note) => note.id === block.id).stale,
    true
  );
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Unfinished ordinary draft must survive context refresh."
  );
  fs.unlinkSync(path.join(root, "flow.tsx"));
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(
        '[data-step="nested"] .function-context'
      )?.textContent === "Source unavailable"
  );
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Unfinished ordinary draft must survive context refresh."
  );
  assert.equal(
    fs.readFileSync(disk, "utf8"),
    saved,
    "reading context must never rewrite workspace data"
  );
  assert.equal(
    fs.statSync(disk).mtimeMs,
    savedMtime,
    "reads must not even rewrite identical store bytes"
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Callback role…", exact: true })
      .count(),
    0
  );
  assert.equal(await page.getByRole("tooltip").count(), 0);
  assert.equal(await page.locator("#error").isVisible(), false);
  assert.deepEqual(errors, []);
  // Restore the fixture source only; do not review or alter any saved notes.
  fs.writeFileSync(path.join(root, "flow.tsx"), source);
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(
        '[data-step="nested"] .function-context'
      )?.textContent === "first › same"
  );
  await page.screenshot({ path: path.join(artifacts, "function-context.png") });
  console.log(
    "PASS actual Chrome: in-code function names, common outer/nested/whole scopes, honest siblings/top-level/unknown/unavailable, current AST names despite stale explanations, unchanged source/selection/highlights and preserved draft/notes without reader writes."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
