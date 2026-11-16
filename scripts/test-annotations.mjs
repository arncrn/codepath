import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";
import { dispatchWebviewRequest } from "../dist/vscode/bridge.mjs";

const artifacts = path.resolve(
  process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/annotations"
);
fs.mkdirSync(artifacts, { recursive: true });
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "codepath-annotation-browser-")
);
const source =
  "export function one() {\n  const value = 1;\n  return value;\n}\nexport function two() { const value = 2; return value; }\n";
fs.writeFileSync(path.join(root, "flow.ts"), source);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  let walk = await service.call("save_walkthrough", {
    title: "Annotation fixture",
    steps: [
      {
        id: "one",
        title: "One",
        source: { file: "flow.ts", symbol: "one" },
        explanation: "Summary",
      },
    ],
  });
  const legacy = await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "one",
    body: "Legacy unanchored detail",
    author: "Original author",
  });
  async function review() {
    walk = await service.call("get_walkthrough", { id: walk.id });
    return {
      walkthroughId: walk.id,
      stepId: "one",
      expectedRevision: walk.revision,
      sourceHash: walk.steps[0].code.hash,
      fileHash: walk.steps[0].code.fileHash,
      author: "Browser fixture",
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
      text: source.split("\n")[line - 1].slice(from, to),
    };
  }
  await review();
  const variable = await service.call("add_reviewed_note", {
    ...(await review()),
    body: "The local value holds the result for one only.",
    variableName: "value",
    attachments: [range(2, 8, 13), range(3, 9, 14)],
  });
  const block = await service.call("add_reviewed_note", {
    ...(await review()),
    body: "This declaration initializes the local result.",
    attachments: [range(2, 2, 18)],
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator('.code-card[data-step="one"]').waitFor();
  const value = page
    .locator('code[data-source-line="2"] .source-attachment')
    .filter({ hasText: /^value$/ });
  await value.hover();
  await page.waitForTimeout(800);
  assert.equal(
    await page.getByRole("tooltip").count(),
    0,
    "Hover must not cover the source with explanations."
  );
  assert.deepEqual(
    await page.locator("code[data-source-line]").allTextContents(),
    source.split("\n"),
    "annotation wrappers preserve exact displayed source text"
  );
  await page.screenshot({ path: path.join(artifacts, "hover.png") });
  assert.equal(await page.locator("#variables-panel").isVisible(), false);
  assert.equal(
    await page.locator('code[data-source-line="5"] .source-attachment').count(),
    0,
    "same name in another scope is not attached"
  );
  await value.click();
  assert.equal(await page.locator("#variables-panel").isVisible(), true);
  assert.equal(
    await page.locator('#variables-panel [aria-current="true"]').count(),
    1
  );
  assert.equal(
    await page
      .locator(`[data-explanation-id="${variable.id}"]`)
      .getAttribute("aria-current"),
    "true"
  );
  assert.equal(
    await page
      .locator(`[data-explanation-id="${block.id}"]`)
      .getAttribute("aria-current"),
    null
  );
  await page.locator("#notes-tab").click();
  await page
    .locator("#note-text")
    .fill("A draft preserved across annotation reveals");
  await page.locator("#flow-tab").click();
  await value.focus();
  await value.press("Space");
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "A draft preserved across annotation reveals"
  );
  assert.equal(
    await value.evaluate(
      (element) => element === globalThis.document.activeElement
    ),
    true,
    "revealing does not move keyboard focus"
  );
  await page.locator('code[data-source-line="2"]').evaluate((code) => {
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
      throw Error("position missing");
    }
    const selection = globalThis.getSelection(),
      range = globalThis.document.createRange();
    range.setStart(...position(8));
    range.setEnd(...position(13));
    selection.removeAllRanges();
    selection.addRange(range);
    code.dispatchEvent(new globalThis.MouseEvent("mouseup", { bubbles: true }));
  });
  await page.locator("#notes-tab").click();
  const legacyCard = page.locator(`[data-explanation-id="${legacy.id}"]`);
  await legacyCard.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".annotation-editor");
  await editor
    .getByLabel("Reviewed explanation")
    .fill("Corrected individual variable explanation");
  await editor
    .getByRole("button", { name: "Attach selected source range", exact: true })
    .click();
  assert.match(await editor.innerText(), /2:8 to 2:13/);
  await editor
    .getByRole("button", { name: "Save reviewed explanation", exact: true })
    .click();
  await legacyCard
    .getByText("Corrected individual variable explanation", { exact: true })
    .waitFor();
  walk = await service.call("get_walkthrough", { id: walk.id });
  const saved = walk.steps[0].notes.find((note) => note.id === legacy.id);
  assert.equal(saved.history[0].body, legacy.body);
  assert.equal(saved.history[0].author, "Original author");
  assert.equal(saved.attachments[0].startColumn, 8);
  await legacyCard.getByRole("button", { name: "Edit", exact: true }).click();
  await editor
    .getByLabel("Reviewed explanation")
    .fill("Draft during concurrent revision");
  await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "one",
    body: "Concurrent note",
    author: "Agent",
  });
  await page.getByText("Concurrent note", { exact: true }).waitFor();
  await editor
    .getByRole("button", { name: "Save reviewed explanation", exact: true })
    .click();
  await page.locator("#error").filter({ hasText: "Path changed" }).waitFor();
  assert.equal(
    await editor.getByLabel("Reviewed explanation").inputValue(),
    "Draft during concurrent revision"
  );
  await editor
    .getByRole("button", {
      name: "Use my edit",
      exact: true,
    })
    .click();
  await editor
    .getByRole("button", { name: "Save reviewed explanation", exact: true })
    .click();
  await legacyCard
    .getByText("Draft during concurrent revision", { exact: true })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Edit card explanation",
      exact: true,
    })
    .click();
  await editor
    .getByLabel("Reviewed explanation")
    .fill("A deliberately reviewed card summary");
  await editor
    .getByRole("button", { name: "Attach selected source range", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Save reviewed explanation", exact: true })
    .click();
  await page
    .locator(".reason")
    .getByText("A deliberately reviewed card summary", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Write attached note", exact: true })
    .click();
  await editor
    .getByLabel("Reviewed explanation")
    .fill("A new UI-authored variable explanation");
  await editor
    .getByRole("button", { name: "Attach selected source range", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Save reviewed explanation", exact: true })
    .click();
  await page
    .locator("#notes")
    .getByText("A new UI-authored variable explanation", { exact: true })
    .waitFor();
  const heldReview = Promise.withResolvers(),
    reviewArrived = Promise.withResolvers();
  let holdUsed = false;
  const holdReviewResponse = async (route) => {
    if (holdUsed || route.request().postDataJSON()?.name !== "review_note")
      return route.continue();
    holdUsed = true;
    const response = await route.fetch();
    reviewArrived.resolve();
    await heldReview.promise;
    await route.fulfill({ response });
  };
  await page.route("**/api/call", holdReviewResponse);
  await legacyCard.getByRole("button", { name: "Edit", exact: true }).click();
  await editor
    .getByLabel("Reviewed explanation")
    .fill("Review submitted before later typing");
  await editor
    .getByRole("button", { name: "Save reviewed explanation", exact: true })
    .click();
  await reviewArrived.promise;
  await editor
    .getByLabel("Reviewed explanation")
    .fill("A later edit survives the delayed review response");
  heldReview.resolve();
  await legacyCard
    .getByText("Review submitted before later typing", { exact: true })
    .waitFor();
  await page.waitForFunction(() => {
    const button = globalThis.document.querySelector(
      ".annotation-editor button.primary"
    );
    return button && !button.disabled;
  });
  assert.equal(
    await editor.getByLabel("Reviewed explanation").inputValue(),
    "A later edit survives the delayed review response"
  );
  await page.unroute("**/api/call", holdReviewResponse);
  await editor
    .getByRole("button", { name: "Keep draft and close", exact: true })
    .click();
  await page.screenshot({ path: path.join(artifacts, "browser.png") });
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    source.replace("value = 1", "value = 7")
  );
  await page.locator("#refresh").click();
  await legacyCard
    .getByText("Attachments need source review. Select their ranges again.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.locator(".source-attachment").count(),
    0,
    "changed source never displays stale previews"
  );
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    source.replace("one()", "renamed()")
  );
  await page.locator("#refresh").click();
  await page
    .locator(".code .source-error")
    .filter({ hasText: "Missing or ambiguous symbol" })
    .waitFor();
  assert.equal(
    await legacyCard
      .getByRole("button", { name: "Edit", exact: true })
      .isDisabled(),
    true,
    "unresolved source must be repaired before review"
  );
  await page
    .getByRole("button", { name: "Repair source reference", exact: true })
    .click();
  await page.locator("#range-file").selectOption("flow.ts");
  const previewA = source.replace("one()", "renamed()");
  await page
    .locator("#range-preview")
    .filter({ hasText: "renamed()" })
    .waitFor();
  await page.locator("#range-start").fill("5");
  await page.locator("#range-end").fill("5");
  const displayedA = await page.locator("#range-preview").innerText();
  assert.match(displayedA, /value = 2/);
  const unseenB = previewA.replace("value = 2", "value = 99");
  const beforeUnseenVersion = (
    await service.call("project_overview", { walkthroughId: walk.id })
  ).index.version;
  fs.writeFileSync(path.join(root, "flow.ts"), unseenB);
  await page.waitForResponse(
    async (response) =>
      response.request().postDataJSON()?.name === "project_overview" &&
      (await response.json()).index.version !== beforeUnseenVersion
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve)
        )
      )
  );
  assert.equal(await page.locator("#range-preview").innerText(), displayedA);
  assert.equal(await page.locator("#range-start").inputValue(), "5");
  assert.equal(await page.locator("#range-end").inputValue(), "5");
  const metadataPath = path.join(root, ".codepaths/workspace.json");
  const beforeUnseen = fs.readFileSync(metadataPath, "utf8");
  const beforeRejected = await service.call("get_walkthrough", { id: walk.id });
  const repairResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.name === "repair_step_source"
  );
  await page.locator("#range-add").click();
  const attemptedRepair = await repairResponse;
  console.log(
    "Repair after unseen B",
    attemptedRepair.status(),
    JSON.stringify(await attemptedRepair.json())
  );
  assert.equal(
    fs.readFileSync(metadataPath, "utf8"),
    beforeUnseen,
    "unseen source cannot change repair, history or review freshness"
  );
  await page
    .locator("#modal-error")
    .filter({ hasText: "Source changed" })
    .waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#modal").isVisible(), true);
  assert.deepEqual(
    await service.call("get_walkthrough", { id: walk.id }),
    beforeRejected
  );
  assert.equal(
    await page.locator("#range-add").isDisabled(),
    true,
    "a conflict requires another explicit preview, not another blind confirmation"
  );
  await page.screenshot({
    path: path.join(artifacts, "repair-conflict.png"),
  });
  await page
    .getByRole("button", { name: "Preview current source", exact: true })
    .click();
  await page
    .locator("#range-preview")
    .filter({ hasText: "value = 99" })
    .waitFor();
  await page.locator("#range-start").fill("5");
  await page.locator("#range-end").fill("5");
  await page.locator("#range-add").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  walk = await service.call("get_walkthrough", { id: walk.id });
  assert.equal(walk.steps[0].id, "one");
  assert.equal(walk.steps[0].stale, true);
  assert.ok(walk.steps[0].notes.every((note) => note.stale));
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "A draft preserved across annotation reveals"
  );

  assert.match(walk.steps[0].code.excerpt, /value = 99/);
  assert.deepEqual(
    walk.steps[0].explanationHistory,
    beforeRejected.steps[0].explanationHistory
  );
  console.log(
    "PASS repair rejects unseen B after preview A and polling, preserves persisted state, and accepts explicit repreview of B."
  );

  await page
    .getByRole("button", { name: "Repair source reference", exact: true })
    .click();
  await page.locator("#symbol-query").fill("two");
  await page.locator("#symbol-results .choice").first().click();
  await page
    .locator("#range-preview")
    .filter({ hasText: "value = 99" })
    .waitFor();
  const symbolBefore = fs.readFileSync(metadataPath, "utf8");
  const beforeSymbolVersion = (
    await service.call("project_overview", { walkthroughId: walk.id })
  ).index.version;
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    unseenB.replace("value = 99", "value = 88")
  );
  await page.waitForResponse(
    async (response) =>
      response.request().postDataJSON()?.name === "project_overview" &&
      (await response.json()).index.version !== beforeSymbolVersion
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve)
        )
      )
  );
  await page.locator("#range-add").click();
  await page
    .locator("#modal-error")
    .filter({ hasText: "Source changed" })
    .waitFor();
  assert.equal(
    fs.readFileSync(metadataPath, "utf8"),
    symbolBefore,
    "a selected symbol stays bound to its reviewed snapshot through polling"
  );
  await page
    .getByRole("button", { name: "Preview current source", exact: true })
    .click();
  await page
    .locator("#range-preview")
    .filter({ hasText: "value = 88" })
    .waitFor();
  await page.locator("#range-start").fill("5");
  await page.locator("#range-end").fill("5");
  await page.locator("#range-add").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  console.log(
    "PASS symbol repair selection freezes its reviewed fingerprint and requires explicit preview after conflict."
  );
  await page
    .getByRole("button", { name: "Repair source reference", exact: true })
    .click();
  await page.locator("#symbol-query").fill("two");
  await page.locator("#symbol-results .choice").first().click();
  await page
    .locator("#range-preview")
    .filter({ hasText: "value = 88" })
    .waitFor();
  await page.locator("#range-add").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  walk = await service.call("get_walkthrough", { id: walk.id });
  assert.deepEqual(
    walk.steps[0].source,
    { file: "flow.ts", symbol: "two" },
    "confirmed unique symbol selection retains symbolic relocation semantics"
  );

  const repairedColumn = source.split("\n")[4].indexOf("value");
  await service.call("add_reviewed_note", {
    ...(await review()),
    body: "The second function has its own value.",
    variableName: "value",
    attachments: [range(5, repairedColumn, repairedColumn + 5)],
  });
  const nativeGestures = [];
  const nativeComplete = Promise.withResolvers();
  const host = await browser.newPage();
  await host.exposeFunction("hostRequest", async (message) => {
    try {
      const result =
        message.route === "follow-reference"
          ? (nativeGestures.push(message.body),
            nativeGestures.length === 3 && nativeComplete.resolve(),
            { cancelled: true })
          : message.route.startsWith("reading-context/")
            ? null
            : await dispatchWebviewRequest(
                service,
                message.route,
                message.body
              );
      return { type: "codepath.response", id: message.id, result };
    } catch (error) {
      return {
        type: "codepath.response",
        id: message.id,
        error: error.message,
      };
    }
  });
  await host.addInitScript(() => {
    let config;
    Object.defineProperty(globalThis, "CODEPATH_CONFIG", {
      get: () => config,
      set: (value) => {
        config = { ...value, host: "vscode" };
      },
    });
    globalThis.acquireVsCodeApi = () => ({
      postMessage: (message) => {
        void globalThis
          .hostRequest(message)
          .then((response) => globalThis.postMessage(response, "*"));
      },
    });
  });
  await host.goto(service.url);
  await host.locator(".source-token").first().waitFor();
  const token = host
    .locator('code[data-source-line="5"] .source-token.source-attachment')
    .filter({ hasText: /^value$/ })
    .first();
  await token.focus();
  await token.press("Space");
  await host
    .getByText("The second function has its own value.", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    nativeGestures.length,
    0,
    "Space reveals without following a definition"
  );
  await token.click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  await token.press("Enter");
  await host.waitForLoadState("networkidle");
  await token.evaluate((element) =>
    element.scrollIntoView({ behavior: "instant", block: "center" })
  );
  await token.click({ button: "right" });
  await host.locator("[data-symbol-follow]").click();
  const nativeTimeout = setTimeout(
    () =>
      nativeComplete.reject(
        Error(
          "Only " +
            nativeGestures.length +
            " definition requests arrived: " +
            JSON.stringify(nativeGestures)
        )
      ),
    5000
  );
  try {
    await nativeComplete.promise;
  } finally {
    clearTimeout(nativeTimeout);
  }
  assert.equal(
    nativeGestures.length,
    3,
    "shared React forwards all established definition gestures to the host"
  );
  await service.call("review_explanation", {
    ...(await review()),
    body: "Reviewed current card",
    attachments: [],
  });
  walk = await service.call("get_walkthrough", { id: walk.id });
  await service.call("save_walkthrough", {
    ...walk,
    expectedRevision: walk.revision,
    steps: [
      {
        ...walk.steps[0],
        explanation: "Generic body edit needs deliberate review",
      },
    ],
  });
  await page
    .locator(".reason")
    .getByText("Generic body edit needs deliberate review", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".card-title .badge.warning").innerText(),
    "Explanation needs review",
    "a body-only edit is not evidence that source contents changed"
  );
  walk = await service.call("get_walkthrough", { id: walk.id });
  fs.copyFileSync(path.join(root, "flow.ts"), path.join(root, "copy.ts"));
  await service.call("save_walkthrough", {
    ...walk,
    expectedRevision: walk.revision,
    steps: [
      {
        ...walk.steps[0],
        source: { file: "copy.ts", startLine: 5, endLine: 5 },
      },
    ],
  });
  await page
    .locator(".code-card .filename")
    .filter({ hasText: "copy.ts" })
    .waitFor();
  assert.equal(
    await page.locator(".card-title .badge.warning").innerText(),
    "Explanation needs review"
  );
  const independentlyUnreviewed = page
    .locator(".note")
    .filter({ hasText: "The second function has its own value." });
  assert.equal(
    await independentlyUnreviewed.locator(".badge.warning").innerText(),
    "Note needs review"
  );
  await page.screenshot({ path: path.join(artifacts, "warnings.png") });
  console.log(
    "PASS generic body edit and equal-content source replacement show truthful independent needs-review warnings."
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual Chrome annotation authoring, variable-only scoped reveal without hover popups, keyboard focus, drafts, conflict rejection, source invalidation and picker repair. Shared React host-bridge gesture forwarding also passed. No native-editor hover claimed."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
