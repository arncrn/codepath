import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";
import {
  dispatchReadingContext,
  dispatchWebviewRequest,
  webviewHtml,
} from "../dist/vscode/bridge.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-variables-"));
const artifacts = path.resolve(
  process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/variables"
);
fs.mkdirSync(artifacts, { recursive: true });
const source = [
  "export function render() {",
  '  const value = "😀<&>";',
  "  function inner() { const value = 2; return value; }",
  '  return "😀" + value;',
  "}",
  "",
].join("\r\n");
const lines = source.split("\n");
fs.writeFileSync(path.join(root, "flow.ts"), source);
let service, browser, walk;
const errors = [];
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  walk = await service.call("save_walkthrough", {
    id: "variables",
    title: "Variable layout fixture",
    steps: [
      {
        id: "one",
        title: "One",
        source: { file: "flow.ts", symbol: "render" },
        explanation: "Overall purpose lives only on the card.",
      },
    ],
  });
  async function review() {
    walk = await service.call("get_walkthrough", { id: walk.id });
    return {
      walkthroughId: walk.id,
      stepId: "one",
      expectedRevision: walk.revision,
      sourceHash: walk.steps[0].code.hash,
      fileHash: walk.steps[0].code.fileHash,
      author: "Fixture reviewer",
    };
  }
  function range(line, from, to) {
    return {
      file: "flow.ts",
      fileHash: walk.steps[0].code.fileHash,
      startLine: line,
      endLine: line,
      startColumn: from,
      endColumn: to,
      text: lines[line - 1].slice(from, to),
    };
  }
  async function note(body, attachments, presentation = {}) {
    return service.call("add_reviewed_note", {
      ...(await review()),
      body,
      attachments,
      ...presentation,
    });
  }
  await review();
  const outerRange = range(2, 8, 13);
  const returnColumn = lines[3].indexOf("value");
  const innerColumn = lines[2].indexOf("value");
  const whole = {
    ...range(1, 0, lines[0].length),
    endLine: 5,
    endColumn: 1,
    text: lines.slice(0, 5).join("\n").slice(0, -1),
  };
  // Final line has a CR; the selected function ends before it.
  await service.call("review_explanation", {
    ...(await review()),
    body: "Overall purpose lives only on the card.",
    attachments: [whole],
  });
  const outer = await note(
    "Outer binding purpose.",
    [outerRange, range(4, returnColumn, returnColumn + 5)],
    { variableName: "value" }
  );
  const overlap = await note(
    "Second purpose on the same target.",
    [outerRange],
    { variableName: "value" }
  );
  const inner = await note(
    "Inner binding, not the outer binding.",
    [range(3, innerColumn, innerColumn + 5)],
    { variableName: "value" }
  );
  const partial = await note(
    "An explicitly authored function-value explanation.",
    [range(1, 16, 22)],
    { variableName: "render" }
  );
  const block = await note("This whole function is a block explanation.", [
    whole,
  ]);
  const legacy = await note(
    "Medium: value — legacy prose is not classification.",
    [range(3, 11, 16)]
  );
  const archived = await note(
    "Obsolete variable purpose.",
    [
      range(
        3,
        lines[2].lastIndexOf("value"),
        lines[2].lastIndexOf("value") + 5
      ),
    ],
    { variableName: "value", archived: true }
  );
  const archivedBlock = await note("Old glossary kept for history.", [whole], {
    archived: true,
  });
  await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "one",
    body: "Legacy unclassified variable glossary.",
    author: "Original author",
  });

  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator('.code-card[data-step="one"]').waitFor();
  const notes = page.locator("#notes-panel");
  const variables = page.locator("#variables-panel");
  const entry = (id) => page.locator(`[data-explanation-id="${id}"]`);
  const editor = (panel) => panel.locator(".annotation-editor");
  const save = (panel) =>
    editor(panel)
      .getByRole("button", { name: "Save reviewed explanation", exact: true })
      .click();
  const close = (panel) =>
    editor(panel)
      .getByRole("button", { name: "Keep draft and close", exact: true })
      .click();
  const openNote = (id) =>
    entry(id).getByRole("button", { name: "Edit", exact: true }).click();
  const acceptLatest = async (panel) => {
    const button = editor(panel).getByRole("button", {
      name: "Use my edit",
      exact: true,
    });
    if (await button.isVisible()) await button.click();
  };
  const codeValue = page
    .locator('code[data-source-line="2"] .source-attachment')
    .filter({ hasText: /^value$/ });
  assert.equal(await page.locator("#notes-tab").innerText(), "Notes · 3");
  assert.equal(
    await page.locator("#variables-tab").innerText(),
    "Variables · 4"
  );
  await page.locator("#notes-tab").click();
  assert.equal(
    await notes
      .getByText("Overall purpose lives only on the card.", { exact: true })
      .count(),
    0
  );
  assert.equal(await entry(block.id).isVisible(), true);
  assert.equal(await entry(legacy.id).isVisible(), true);
  assert.equal(await entry(outer.id).isVisible(), false);
  assert.doesNotMatch(
    await entry(block.id).innerText(),
    /flow.ts 1:0 to 5:1|Fixture reviewer/
  );
  assert.equal(await entry(block.id).locator(".note-details").count(), 0);
  assert.equal(
    (
      await service.call("get_walkthrough", { id: walk.id })
    ).steps[0].notes.find((note) => note.id === block.id).attachments[0].text,
    whole.text
  );
  assert.equal(await entry(archivedBlock.id).isVisible(), false);
  assert.equal(await entry(archived.id).isVisible(), false);
  assert.equal(
    await page
      .locator('code[data-source-line="3"] .source-attachment')
      .allTextContents()
      .then((texts) => texts.join("")),
    "value"
  );
  assert.deepEqual(
    await page.locator("code[data-source-line]").allTextContents(),
    lines
  );
  assert.ok(await page.locator(".syntax-keyword").count());
  assert.ok(await page.locator(".syntax-string").count());
  for (const target of [
    codeValue,
    page.locator('code[data-source-line="1"] .source-attachment'),
  ]) {
    await target.hover();
    await target.focus();
    assert.equal(await page.getByRole("tooltip").count(), 0);
    assert.equal(
      await notes.isVisible(),
      true,
      "hover/focus does not change tabs"
    );
    assert.equal(await target.getAttribute("title"), null);
  }
  assert.equal(
    await page.locator(".code [title]").count(),
    0,
    "browser source has no whole-body native titles"
  );
  await codeValue.click();
  assert.equal(await variables.isVisible(), true);
  assert.deepEqual(
    await variables
      .locator('[aria-current="true"]')
      .evaluateAll((els) => els.map((el) => el.dataset.explanationId).sort()),
    [outer.id, overlap.id].sort()
  );
  assert.equal(await entry(block.id).getAttribute("aria-current"), null);
  await page.locator("#data-tab").click();
  await codeValue.focus();
  await codeValue.press("Space");
  assert.equal(await variables.isVisible(), true);
  assert.equal(
    await codeValue.evaluate((el) => el === globalThis.document.activeElement),
    true
  );
  await page.locator(`code[data-source-line="3"] .source-attachment`).click();
  assert.deepEqual(
    await variables
      .locator('[aria-current="true"]')
      .evaluateAll((els) => els.map((el) => el.dataset.explanationId)),
    [inner.id]
  );

  // Distinct target drafts survive switching editors, tabs and a real service poll.
  await page.locator("#notes-tab").click();
  await page.locator("#note-text").fill("Generic block draft");
  await notes
    .getByRole("button", { name: "Write attached note", exact: true })
    .click();
  await editor(notes)
    .getByLabel("Reviewed explanation")
    .fill("New attached block draft");
  assert.equal(
    await editor(notes)
      .getByLabel("Classification", { exact: true })
      .inputValue(),
    "block"
  );
  await openNote(legacy.id);
  await editor(notes)
    .getByLabel("Reviewed explanation")
    .fill("Legacy editor draft");
  await close(notes);
  await notes
    .getByRole("button", { name: "Write attached note", exact: true })
    .click();
  assert.equal(
    await editor(notes).getByLabel("Reviewed explanation").inputValue(),
    "New attached block draft"
  );
  await page.locator("#variables-tab").click();
  await variables
    .getByRole("button", { name: "Write variable explanation", exact: true })
    .click();
  await editor(variables)
    .getByLabel("Variable name", { exact: true })
    .fill("value");
  await editor(variables)
    .getByLabel("Reviewed explanation")
    .fill("New variable draft");
  await openNote(outer.id);
  await editor(variables)
    .getByLabel("Reviewed explanation")
    .fill("Existing variable editor draft");
  await close(variables);
  await variables
    .getByRole("button", { name: "Write variable explanation", exact: true })
    .click();
  assert.equal(
    await editor(variables).getByLabel("Reviewed explanation").inputValue(),
    "New variable draft"
  );
  await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "one",
    body: "Poll arrived",
    author: "Concurrent author",
  });
  await page.locator("#notes-tab").click();
  await notes.getByText("Poll arrived", { exact: true }).waitFor();
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Generic block draft"
  );
  assert.equal(
    await editor(notes).getByLabel("Reviewed explanation").inputValue(),
    "New attached block draft"
  );
  await openNote(legacy.id);
  assert.equal(
    await editor(notes).getByLabel("Reviewed explanation").inputValue(),
    "Legacy editor draft"
  );
  assert.match(
    await editor(notes).innerText(),
    /This walkthrough changed while you were editing/
  );
  assert.equal(
    await editor(notes).locator("blockquote").innerText(),
    legacy.body
  );
  assert.doesNotMatch(
    await editor(notes).innerText(),
    /Expected metadata revision|Reviewed source hash|Reviewed file hash/
  );
  await close(notes);
  await page.locator("#variables-tab").click();
  await openNote(outer.id);
  assert.equal(
    await editor(variables).getByLabel("Reviewed explanation").inputValue(),
    "Existing variable editor draft"
  );
  await close(variables);
  await variables
    .getByRole("button", { name: "Write variable explanation", exact: true })
    .click();
  assert.equal(
    await editor(variables)
      .getByLabel("Variable name", { exact: true })
      .inputValue(),
    "value"
  );
  assert.equal(
    await editor(variables)
      .getByLabel("Variable name", { exact: true })
      .getAttribute("required"),
    ""
  );
  await save(variables);
  await page
    .locator("#error")
    .filter({ hasText: "Every attachment must select exactly that name" })
    .waitFor();
  assert.equal(
    await editor(variables).getByLabel("Reviewed explanation").inputValue(),
    "New variable draft"
  );

  async function select(line, from, to) {
    await page.locator(`code[data-source-line="${line}"]`).evaluate(
      (code, { from, to }) => {
        const nodes = [],
          walker = globalThis.document.createTreeWalker(
            code,
            globalThis.NodeFilter.SHOW_TEXT
          );
        while (walker.nextNode()) nodes.push(walker.currentNode);
        function position(offset) {
          for (const node of nodes) {
            if (offset <= node.textContent.length) return [node, offset];
            offset -= node.textContent.length;
          }
          throw Error("selection position missing");
        }
        const selection = globalThis.getSelection(),
          selected = globalThis.document.createRange();
        selected.setStart(...position(from));
        selected.setEnd(...position(to));
        selection.removeAllRanges();
        selection.addRange(selected);
        code.dispatchEvent(
          new globalThis.MouseEvent("mouseup", { bubbles: true })
        );
        selection.removeAllRanges();
      },
      { from, to }
    );
  }
  await select(3, 11, 16);
  await editor(variables)
    .getByRole("button", { name: "Attach selected source range", exact: true })
    .click();
  await page.locator("#error").click();
  await save(variables);
  await page
    .locator("#error")
    .filter({ hasText: "Every attachment must select exactly that name" })
    .waitFor();
  await editor(variables)
    .getByRole("button", { name: "Remove attachment 1", exact: true })
    .click();
  await select(4, returnColumn, returnColumn + 5);
  await editor(variables)
    .getByRole("button", { name: "Attach selected source range", exact: true })
    .click();
  const beforeConflict = fs.readFileSync(
    path.join(root, ".codepaths/workspace.json"),
    "utf8"
  );
  await save(variables);
  await page.locator("#error").filter({ hasText: "Path changed" }).waitFor();
  assert.equal(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
    beforeConflict
  );
  assert.equal(
    await editor(variables).getByLabel("Reviewed explanation").inputValue(),
    "New variable draft"
  );
  await editor(variables)
    .getByRole("button", { name: "Use my edit", exact: true })
    .click();
  await save(variables);
  await variables
    .locator("#variables")
    .getByText("New variable draft", { exact: true })
    .waitFor();
  walk = await service.call("get_walkthrough", { id: walk.id });
  const authored = walk.steps[0].notes.find(
    (note) => note.body === "New variable draft"
  );
  assert.equal(authored.variableName, "value");
  assert.equal(authored.archived, false);
  assert.deepEqual(authored.attachments, [
    {
      ...range(4, returnColumn, returnColumn + 5),
      sourceExcerpt: lines.slice(0, 5).join("\n"),
      sourceStartLine: 1,
    },
  ]);

  // Later typing must not be erased by an earlier save response, including when
  // another editor/tab is used while the real mutation response is delayed.
  const held = Promise.withResolvers(),
    arrived = Promise.withResolvers();
  const delayReview = async (route) => {
    if (route.request().postDataJSON()?.name !== "review_note")
      return route.continue();
    const response = await route.fetch();
    arrived.resolve();
    await held.promise;
    await route.fulfill({ response });
  };
  await page.route("**/api/call", delayReview);
  await openNote(outer.id);
  await editor(variables)
    .getByLabel("Reviewed explanation")
    .fill("Submitted variable review");
  await acceptLatest(variables);
  await save(variables);
  await arrived.promise;
  await editor(variables)
    .getByLabel("Reviewed explanation")
    .fill("Later variable typing survives");
  await page.locator("#notes-tab").click();
  await notes
    .getByRole("button", { name: "Write attached note", exact: true })
    .click();
  assert.equal(
    await editor(notes).getByLabel("Reviewed explanation").inputValue(),
    "New attached block draft"
  );
  held.resolve();
  await page.locator("#variables-tab").click();
  await variables
    .locator("#variables")
    .getByText("Submitted variable review", { exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      !globalThis.document.querySelector(
        "#variables-panel .annotation-editor button.primary"
      )?.disabled
  );
  assert.equal(
    await editor(variables).getByLabel("Reviewed explanation").inputValue(),
    "Later variable typing survives"
  );
  await page.unroute("**/api/call", delayReview);
  await close(variables);

  // Archive/history data remains intact, without reader-facing management panels.
  assert.equal(await page.locator(".archived-notes").count(), 0);
  assert.equal(await entry(archived.id).count(), 0);
  await service.call("review_note", {
    ...(await review()),
    noteId: archived.id,
    body: archived.body,
    attachments: archived.attachments,
    archived: false,
  });
  await variables
    .locator(`#variables [data-explanation-id="${archived.id}"]`)
    .waitFor();
  let saved = (
    await service.call("get_walkthrough", { id: walk.id })
  ).steps[0].notes.find((note) => note.id === archived.id);
  assert.equal(saved.history[0].archived, true);
  assert.equal(saved.history[0].body, archived.body);
  const restoredTarget = page
    .locator(`code[data-source-line="3"] .source-attachment`)
    .filter({ hasText: /^value$/ })
    .last();
  await restoredTarget.click();
  assert.equal(await entry(archived.id).getAttribute("aria-current"), "true");
  await service.call("review_note", {
    ...(await review()),
    noteId: archived.id,
    body: archived.body,
    attachments: archived.attachments,
    archived: true,
  });
  await variables
    .locator(`[data-explanation-id="${archived.id}"]`)
    .waitFor({ state: "detached" });
  saved = (
    await service.call("get_walkthrough", { id: walk.id })
  ).steps[0].notes.find((note) => note.id === archived.id);
  assert.equal(saved.history.at(-1).archived, false);
  assert.equal(saved.history.at(-1).variableName, "value");
  assert.equal(
    await page.locator('code[data-source-line="3"] .source-attachment').count(),
    1
  );
  await page.locator("#notes-tab").click();
  assert.equal(await entry(archivedBlock.id).count(), 0);
  assert.equal(
    (
      await service.call("get_walkthrough", { id: walk.id })
    ).steps[0].notes.find((note) => note.id === archivedBlock.id).archived,
    true
  );
  await notes
    .getByRole("button", {
      name: "Edit card explanation",
      exact: true,
    })
    .click();
  assert.equal(
    await editor(notes).getByLabel("Reviewed explanation").inputValue(),
    "Overall purpose lives only on the card."
  );
  assert.equal(
    await editor(notes).getByLabel("Classification", { exact: true }).count(),
    0
  );
  await editor(notes)
    .getByLabel("Reviewed explanation")
    .fill("Reviewed card purpose.");
  await acceptLatest(notes);
  await save(notes);
  await page
    .locator(".reason")
    .getByText("Reviewed card purpose.", { exact: true })
    .waitFor();
  assert.equal(
    await notes.getByText("Reviewed card purpose.", { exact: true }).count(),
    0
  );
  assert.equal(
    await notes.getByText("Prior card explanations", { exact: true }).count(),
    0
  );
  assert.ok(
    (
      await service.call("get_walkthrough", { id: walk.id })
    ).steps[0].explanationHistory.some(
      (version) => version.body === "Overall purpose lives only on the card."
    )
  );

  // Explicit classification changes: no prose/range heuristics, null clears name.
  await openNote(legacy.id);
  await editor(notes)
    .getByLabel("Classification", { exact: true })
    .selectOption("variable");
  await editor(notes)
    .getByLabel("Variable name", { exact: true })
    .fill("inner");
  await acceptLatest(notes);
  await save(notes);
  await page.locator("#variables-tab").click();
  await variables
    .locator(`#variables [data-explanation-id="${legacy.id}"]`)
    .waitFor();
  await openNote(legacy.id);
  assert.equal(
    await editor(variables)
      .getByLabel("Variable name", { exact: true })
      .inputValue(),
    "inner"
  );
  await editor(variables)
    .getByLabel("Classification", { exact: true })
    .selectOption("block");
  await save(variables);
  await page.locator("#notes-tab").click();
  await notes.locator(`#notes [data-explanation-id="${legacy.id}"]`).waitFor();
  saved = (
    await service.call("get_walkthrough", { id: walk.id })
  ).steps[0].notes.find((note) => note.id === legacy.id);
  assert.equal(saved.variableName, undefined);
  assert.equal(saved.history.at(-1).variableName, "inner");
  assert.equal(
    await page.locator('code[data-source-line="3"] .source-attachment').count(),
    1
  );

  // Exercise the named UI operations against an older overview. The real service
  // still owns all mutations; interception only removes the advertised capability.
  const apiBundle = await build({
    entryPoints: ["ui/api.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  await page.route("**/variables-api.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: apiBundle.outputFiles[0].text,
    })
  );
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch(),
      overview = await response.json();
    delete overview.capabilities;
    await route.fulfill({ response, json: overview });
  });
  const mutations = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      ["add_reviewed_note", "review_note"].includes(
        request.postDataJSON()?.name
      )
    )
      mutations.push(request.postDataJSON());
  });
  const guardedReview = {
    ...(await review()),
    body: "Must not silently lose classification",
    attachments: [outerRange],
  };
  const beforeGuard = fs.readFileSync(
    path.join(root, ".codepaths/workspace.json"),
    "utf8"
  );
  const failures = await page.evaluate(
    async ({ review, noteId }) => {
      const api = await import("/variables-api.js");
      const results = [];
      for (const [operation, fields] of [
        ["addReviewedNote", { variableName: "value" }],
        ["addReviewedNote", { archived: false }],
        ["reviewNote", { noteId, variableName: null }],
        ["reviewNote", { noteId, archived: false }],
      ]) {
        try {
          await api[operation]({ ...review, ...fields });
          results.push("unexpected mutation");
        } catch (error) {
          results.push(error.message);
        }
      }
      return results;
    },
    { review: guardedReview, noteId: outer.id }
  );
  assert.ok(
    failures.every((message) =>
      /Reload VS Code, then reopen Codepath.*Your draft is kept/.test(message)
    )
  );
  assert.deepEqual(mutations, []);
  assert.equal(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
    beforeGuard
  );
  await page.evaluate(async (review) => {
    const api = await import("/variables-api.js");
    const added = await api.addReviewedNote({
      ...review,
      body: "Old caller without presentation fields",
    });
    const current = await api.getWalkthrough(review.walkthroughId);
    await api.reviewNote({
      ...review,
      noteId: added.id,
      expectedRevision: current.revision,
      body: "Old review caller still works",
    });
  }, guardedReview);
  assert.equal(
    mutations.filter((request) => request.name === "add_reviewed_note").length,
    1
  );
  assert.equal(
    mutations.filter((request) => request.name === "review_note").length,
    1
  );
  await page.unroute("**/api/state");
  await page.locator("#variables-tab").click();
  await page.waitForFunction(
    (root) =>
      JSON.parse(
        globalThis.localStorage.getItem("codepath.reading-context.v1:" + root)
      )?.tab === "variables",
    service.root
  );
  const revision = (await service.call("get_walkthrough", { id: walk.id }))
    .revision;
  await page.reload();
  await page.locator("#variables-panel").waitFor();
  assert.equal(
    (await service.call("get_walkthrough", { id: walk.id })).revision,
    revision
  );
  await page.screenshot({
    path: path.join(artifacts, "variables-browser.png"),
  });

  // Real nonce-CSP webview UI and service, simulated VS Code host (not native
  // IntelliSense). Whole identifier wrappers and nested segmentation stay intact.
  const hostValues = new Map(),
    requests = [];
  const hostState = {
    get: (key) => hostValues.get(key),
    update: async (key, value) => {
      hostValues.set(key, value);
    },
  };
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await context.exposeBinding("variablesHost", async (_source, message) => {
    try {
      const result = message.route.startsWith("reading-context/")
        ? await dispatchReadingContext(
            hostState,
            service.root,
            message.route,
            message.body
          )
        : message.route === "follow-reference"
          ? (requests.push(message.body), { cancelled: true })
          : await dispatchWebviewRequest(service, message.route, message.body);
      return { type: "codepath.response", id: message.id, result };
    } catch (error) {
      return {
        type: "codepath.response",
        id: message.id,
        error: error.message,
      };
    }
  });
  await context.addInitScript(() => {
    globalThis.acquireVsCodeApi = () => ({
      postMessage: (message) => {
        void globalThis
          .variablesHost(message)
          .then((response) => globalThis.postMessage(response, "*"));
      },
    });
  });
  await context.route("**/variables-host", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: webviewHtml(fs.readFileSync("dist/ui.html", "utf8"), {
        styleUri: service.url + "/style.css",
        themeUri: service.url + "/style.css",
        scriptUri: service.url + "/ui.js",
        cspSource: service.url,
        config: {
          root: service.root,
          toolRoot: path.resolve("."),
          backend: "node",
        },
      }),
    })
  );
  let host = await context.newPage();
  host.on("pageerror", (error) => errors.push(error.message));
  await host.goto(service.url + "/variables-host");
  await host.locator(".source-token").first().waitFor();
  assert.deepEqual(
    await host.locator("code[data-source-line]").allTextContents(),
    lines
  );
  const wrappers = await host.locator(".source-token").evaluateAll((tokens) =>
    tokens.map((token) => ({
      name: token.dataset.sourceName,
      text: token.textContent,
      reference: JSON.parse(token.dataset.reference),
    }))
  );
  walk = await service.call("get_walkthrough", { id: walk.id });
  assert.deepEqual(
    wrappers,
    lines.flatMap((line, index) =>
      [...line.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => ({
        name: match[0],
        text: match[0],
        reference: {
          walkthroughId: walk.id,
          stepId: "one",
          fileHash: walk.steps[0].code.fileHash,
          line: index + 1,
          column: match.index,
        },
      }))
    )
  );
  const wholeIdentifier = host.locator(
    '.source-token[data-source-name="render"]'
  );
  assert.equal(await wholeIdentifier.count(), 1);
  assert.equal(await wholeIdentifier.textContent(), "render");
  assert.equal(
    await wholeIdentifier
      .locator(".source-attachment .syntax-function")
      .textContent(),
    "render"
  );
  assert.deepEqual(
    JSON.parse(
      await wholeIdentifier
        .locator(".source-attachment")
        .getAttribute("data-annotation-ids")
    ),
    [partial.id]
  );
  await wholeIdentifier.hover();
  await wholeIdentifier.focus();
  assert.equal(await host.getByRole("tooltip").count(), 0);
  assert.equal(
    await host.locator('.source-token[title*="purpose"]').count(),
    0
  );
  await wholeIdentifier.press("Space");
  await host.locator("#variables-panel").waitFor();
  await host.waitForFunction(
    () =>
      globalThis.document.querySelector(
        '#variables-panel [aria-current="true"]'
      ) !== null
  );
  assert.equal(
    await host
      .locator(`[data-explanation-id="${partial.id}"]`)
      .getAttribute("aria-current"),
    "true"
  );
  const valueToken = host.locator(
    'code[data-source-line="2"] .source-token[data-source-name="value"]'
  );
  await valueToken.click();
  assert.deepEqual(
    await host
      .locator('#variables-panel [aria-current="true"]')
      .evaluateAll((els) => els.map((el) => el.dataset.explanationId).sort()),
    [outer.id, overlap.id].sort()
  );
  const native = wholeIdentifier.locator(".syntax-function").first();
  for (const gesture of ["Control", "Meta", "Enter", "right"]) {
    const count = requests.length;
    if (gesture === "Control")
      await native.dispatchEvent("click", { ctrlKey: true, bubbles: true });
    else if (gesture === "Meta") await native.click({ modifiers: ["Meta"] });
    else if (gesture === "Enter") {
      await wholeIdentifier.focus();
      await wholeIdentifier.press("Enter");
    } else {
      await native.click({ button: "right" });
      await host.locator("[data-symbol-follow]").click();
    }
    await host.waitForLoadState("networkidle");
    assert.equal(
      requests.length,
      count + 1,
      gesture + " forwards exactly one definition request"
    );
    assert.deepEqual(requests.at(-1), {
      walkthroughId: walk.id,
      stepId: "one",
      fileHash: walk.steps[0].code.fileHash,
      line: 1,
      column: 16,
    });
  }
  await host.waitForFunction(
    () => globalThis.document.querySelector("#variables-tab.active") !== null
  );
  await host.close();
  host = await context.newPage();
  await host.goto(service.url + "/variables-host");
  await host.locator("#variables-panel").waitFor();
  assert.equal(
    (await service.call("get_walkthrough", { id: walk.id })).revision,
    revision
  );
  await host.screenshot({ path: path.join(artifacts, "variables-host.png") });
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    source.replace("😀<&>", "😀changed")
  );
  await host.locator("#refresh").click();
  await host.locator(".card-title .badge.warning").waitFor();
  assert.equal(
    await host.locator(".source-attachment").count(),
    0,
    "source changes invalidate variable interactions, not stored attachments"
  );
  assert.ok(
    (
      await service.call("get_walkthrough", { id: walk.id })
    ).steps[0].notes.find((note) => note.id === outer.id).attachments.length
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual Chrome Variables/Notes/card separation, explicit classifications, scoped multi-note reveals, no automatic popups, retained stored archive/history, independent drafts and polling, exact UTF-16 source/whole-identifier syntax, capability refusal and legacy callers, browser/VS Code tab restoration, and definition gesture forwarding. VS Code host simulated; no native IntelliSense claimed."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
