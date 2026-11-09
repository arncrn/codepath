import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";
import { dispatchWebviewRequest, webviewHtml } from "../dist/vscode/bridge.mjs";
import { followReference } from "../dist/vscode/definition.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
const artifacts =
  process.env.CODEPATH_TEST_OUTPUT_DIR ||
  path.join(base, ".cache/source-syntax");
fs.mkdirSync(artifacts, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepath-syntax-browser-"));
const header =
  "/* multiline comment\nconst notAKeyword = 1;\nthird line\nfourth line\n*/\n";
const malicious =
  '</code><img src=x onerror="globalThis.sourceExecuted=true">&amp;';
const files = {
  "flow.js":
    header +
    `export function render(value) {\n  return \`${malicious} 😀 \${value}\`;\n}\n`,
  "flow.ts": (
    header +
    `export function render(value: string): string {\n  return '${malicious}' + value;\n}\n`
  ).replaceAll("\n", "\r\n"),
  "view.jsx":
    header +
    'export function render(value) {\n  return <Box title="&amp;">literal return {value + 2}</Box>;\n}\n',
  "view.tsx":
    header +
    'export function render(value: string) {\n  return <Box title="&amp;">literal return {value + 2}</Box>;\n}\n',
  "main.go":
    "package main\n/* multiline\nfunc notAKeyword() {}\nfourth line\n*/\nfunc render(value string) string {\n\treturn `raw <img>&amp;\nfunc stillRaw` + value\n}\n",
};
for (const [file, text] of Object.entries(files))
  fs.writeFileSync(path.join(root, file), text);
let service, browser;
const errors = [];
const evidence = {};
try {
  service = await startProjectService(root, {
    assetsRoot: path.join(base, "dist"),
  });
  const walk = await service.call("save_walkthrough", {
    id: "syntax",
    title: "Syntax grammar browser fixture",
    steps: Object.keys(files).map((file, index) => ({
      id: "source-" + index,
      title: file,
      source: { file, startLine: 6, endLine: 6 },
      evidence: "source",
      explanation: "Disposable syntax fixture",
    })),
  });
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator('.code-card[data-step="source-0"]').waitFor();

  async function checkSource(page, native) {
    for (const [index, [file, text]] of Object.entries(files).entries()) {
      const card = page.locator(`.code-card[data-step="source-${index}"]`);
      const lines = text.split("\n");
      assert.deepEqual(await card.locator(".line-number").allTextContents(), [
        "4",
        "5",
        "6",
        "7",
        "8",
      ]);
      assert.deepEqual(
        await card.locator(".line code").allTextContents(),
        lines.slice(3, 8)
      );
      assert.deepEqual(
        await card.locator(".line.focus .line-number").allTextContents(),
        ["6"]
      );
      assert.ok(
        await card.locator(".syntax-comment").count(),
        file + " keeps earlier multiline state"
      );
      assert.ok(
        await card.locator(".syntax-keyword").count(),
        file + " has grammar coloring"
      );
      if (file.endsWith("sx")) {
        assert.ok(await card.locator(".syntax-attribute").count());
        assert.ok(
          await card.locator(".syntax-type").filter({ hasText: "Box" }).count()
        );
      }
      if (file.endsWith(".go")) {
        assert.ok(
          (await card.locator(".syntax-string").allTextContents())
            .join("")
            .includes("func stillRaw")
        );
      }
      await card.locator('[data-action="full"]').click();
      assert.deepEqual(
        await card.locator(".line code").allTextContents(),
        lines
      );
      if (native) {
        const wrappers = await card
          .locator(".source-token")
          .evaluateAll((tokens) =>
            tokens.map((token) => ({
              name: token.dataset.sourceName,
              text: token.textContent,
              tabIndex: token.tabIndex,
              className: token.className,
              reference: JSON.parse(token.dataset.reference),
            }))
          );
        const expected = lines.flatMap((line, lineIndex) =>
          [...line.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => ({
            name: match[0],
            text: match[0],
            tabIndex: 0,
            className: "source-token",
            reference: {
              walkthroughId: walk.id,
              stepId: "source-" + index,
              fileHash: walk.steps[index].code.fileHash,
              line: lineIndex + 1,
              column: match.index,
            },
          }))
        );
        assert.deepEqual(
          wrappers,
          expected,
          file + " preserves every original reference wrapper"
        );
      } else assert.equal(await card.locator(".source-token").count(), 0);
      await card.locator('[data-action="full"]').click();
      assert.deepEqual(
        await card.locator(".line code").allTextContents(),
        lines.slice(3, 8)
      );
    }
    assert.equal(
      await page.locator(".code img, .code script, .code svg").count(),
      0
    );
    assert.equal(
      await page.evaluate(() => globalThis.sourceExecuted ?? false),
      false
    );
    const colors = await page
      .locator('.code-card[data-step="source-0"] .line.focus')
      .evaluate((line) => ({
        keyword: globalThis.getComputedStyle(
          line.querySelector(".syntax-keyword")
        ).color,
        plain: globalThis.getComputedStyle(line.querySelector("code")).color,
      }));
    assert.notEqual(colors.keyword, colors.plain);
    return colors;
  }
  evidence.browser = await checkSource(page, false);
  await page.locator('[data-select="source-0"]').click();
  await page
    .locator('.code-card[data-step="source-0"]')
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(artifacts, "syntax-browser.png"),
  });

  const requests = [];
  const host = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const readingState = new Map();
  await host.exposeBinding("syntaxTestHost", async (_source, message) => {
    try {
      let result;
      if (message.route === "reading-context/get")
        result = readingState.get("value") ?? null;
      else if (message.route === "reading-context/set") {
        readingState.set("value", message.body);
        result = null;
      } else if (message.route === "follow-reference") {
        requests.push(message.body);
        result = await followReference(service, message.body);
      } else
        result = await dispatchWebviewRequest(
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
    globalThis.acquireVsCodeApi = () => ({
      postMessage: (message) => {
        globalThis
          .syntaxTestHost(message)
          .then((response) => globalThis.postMessage(response, "*"));
      },
    });
  });
  await host.route("**/syntax-theme.css", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: fs.readFileSync(path.join(base, "vscode/vscode.css"), "utf8"),
    })
  );
  await host.route("**/syntax-host", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: webviewHtml(
        fs.readFileSync(path.join(base, "dist/ui.html"), "utf8"),
        {
          styleUri: service.url + "/style.css",
          themeUri: service.url + "/syntax-theme.css",
          scriptUri: service.url + "/ui.js",
          cspSource: service.url,
          config: { root, toolRoot: base, backend: "node" },
        }
      ),
    })
  );
  const hosted = await host.newPage();
  hosted.on("pageerror", (error) => errors.push(error.message));
  await hosted.goto(service.url + "/syntax-host");
  await hosted.locator('.code-card[data-step="source-0"]').waitFor();
  await hosted.evaluate(() => {
    const style = globalThis.document.documentElement.style;
    style.setProperty("--vscode-font-family", '"Segoe UI", sans-serif');
    style.setProperty("--vscode-font-size", "13px");
    style.setProperty("--vscode-editor-font-family", "Consolas, monospace");
    style.setProperty("--vscode-editor-background", "#142b30");
    style.setProperty("--vscode-editor-foreground", "#c2d6cf");
  });
  evidence.simulatedHost = await checkSource(hosted, true);
  const nestedToken = () =>
    hosted.locator(
      '.code-card[data-step="source-0"] .source-token[data-source-name="render"] .syntax-function'
    );
  const reference = {
    walkthroughId: walk.id,
    stepId: "source-0",
    fileHash: walk.steps[0].code.fileHash,
    line: 6,
    column: 16,
  };
  await nestedToken().click();
  assert.equal(
    requests.length,
    0,
    "ordinary click does not steal definition gestures"
  );
  for (const gesture of ["context", "Control", "Meta", "Enter"]) {
    const before = (await service.call("get_walkthrough", { id: walk.id }))
      .steps.length;
    if (gesture === "context") {
      await nestedToken().click({ button: "right" });
      await hosted.locator("#source-menu").waitFor();
      await hosted
        .getByRole("menuitem", {
          name: "Follow definition of render",
          exact: true,
        })
        .click();
    } else if (gesture === "Enter") {
      await hosted
        .locator(
          '.code-card[data-step="source-0"] .source-token[data-source-name="render"]'
        )
        .focus();
      assert.equal(
        await hosted
          .locator(
            '.code-card[data-step="source-0"] .source-token[data-source-name="render"]'
          )
          .evaluate((element) => element === globalThis.document.activeElement),
        true
      );
      await hosted.keyboard.press("Enter");
    } else if (gesture === "Control") {
      // macOS maps physical Control-click to contextmenu before React's click handler.
      await nestedToken().dispatchEvent("click", {
        ctrlKey: true,
        bubbles: true,
      });
    } else await nestedToken().click({ modifiers: [gesture] });
    const count = ["context", "Control", "Meta", "Enter"].indexOf(gesture) + 1;
    try {
      await hosted.waitForFunction(
        (expected) =>
          globalThis.document.querySelectorAll(".code-card").length ===
          expected,
        before + 1
      );
    } catch (error) {
      console.error({
        gesture,
        requests,
        error: await hosted.locator("#error").textContent(),
        steps: (await service.call("get_walkthrough", { id: walk.id })).steps
          .length,
      });
      throw error;
    }
    assert.equal(requests.length, count);
    assert.deepEqual(requests.at(-1), reference);
    assert.equal(
      (await service.call("get_walkthrough", { id: walk.id })).steps.length,
      before + 1
    );
  }
  const current = await service.call("get_walkthrough", { id: walk.id });
  const originalStep = current.steps.find((step) => step.id === "source-0");
  const partialBody =
    "Only the authored middle range explains this identifier.";
  const note = await service.call("add_reviewed_note", {
    walkthroughId: walk.id,
    stepId: originalStep.id,
    expectedRevision: current.revision,
    sourceHash: originalStep.code.hash,
    fileHash: originalStep.code.fileHash,
    body: partialBody,
    author: "Syntax composition test",
    attachments: [
      {
        file: "flow.js",
        fileHash: originalStep.code.fileHash,
        startLine: 6,
        startColumn: 17,
        endLine: 6,
        endColumn: 20,
        text: "end",
      },
    ],
  });
  await hosted.locator("#refresh").click();
  const wholeIdentifier = hosted.locator(
    '.code-card[data-step="source-0"] code[data-source-line="6"] .source-token[data-source-name="render"]'
  );
  await hosted.locator('[data-select="source-0"]').click();
  await hosted.locator("#notes-tab").click();
  await hosted
    .locator("#notes-panel")
    .getByText(partialBody, { exact: true })
    .waitFor();
  assert.equal(
    await wholeIdentifier.locator(".source-attachment").count(),
    0,
    "A partial block attachment is not an implicit variable."
  );
  assert.equal(
    await wholeIdentifier.count(),
    1,
    "A stored partial attachment must not split its definition wrapper."
  );
  assert.equal(await wholeIdentifier.textContent(), "render");
  assert.deepEqual(
    JSON.parse(await wholeIdentifier.getAttribute("data-reference")),
    reference
  );
  const withPartial = await service.call("get_walkthrough", { id: walk.id });
  const persistedPartial = withPartial.steps
    .find((step) => step.id === originalStep.id)
    .notes.find((item) => item.id === note.id);
  assert.equal(persistedPartial.attachments[0].text, "end");
  assert.equal(persistedPartial.attachments[0].startColumn, 17);
  assert.equal(persistedPartial.attachments[0].endColumn, 20);
  const namedBody = "The render function value exposed by this module.";
  const named = await service.call("add_reviewed_note", {
    walkthroughId: walk.id,
    stepId: originalStep.id,
    expectedRevision: withPartial.revision,
    sourceHash: originalStep.code.hash,
    fileHash: originalStep.code.fileHash,
    body: namedBody,
    author: "Syntax composition test",
    variableName: "render",
    attachments: [
      {
        file: "flow.js",
        fileHash: originalStep.code.fileHash,
        startLine: 6,
        startColumn: 16,
        endLine: 6,
        endColumn: 22,
        text: "render",
      },
    ],
  });
  await hosted.locator("#refresh").click();
  const exactRange = wholeIdentifier.locator(".source-attachment");
  await exactRange.waitFor();
  assert.equal(await wholeIdentifier.count(), 1);
  assert.equal(await exactRange.textContent(), "render");
  assert.equal(
    await exactRange.locator(".syntax-function").textContent(),
    "render"
  );
  assert.deepEqual(
    JSON.parse(await exactRange.getAttribute("data-annotation-ids")),
    [named.id]
  );
  await exactRange.hover();
  assert.equal(await hosted.getByRole("tooltip").count(), 0);
  await wholeIdentifier.focus();
  await hosted.keyboard.press("Space");
  await hosted
    .locator("#variables-panel")
    .getByText(namedBody, { exact: true })
    .waitFor();
  const beforePartialDefinition = requests.length;
  await exactRange.locator(".syntax-function").click({ modifiers: ["Meta"] });
  await hosted.waitForFunction(
    (count) =>
      globalThis.document.querySelectorAll(".code-card").length === count,
    current.steps.length + 1
  );
  assert.equal(requests.length, beforePartialDefinition + 1);
  assert.deepEqual(requests.at(-1), reference);
  evidence.partialAttachment =
    "The partial block attachment retains exact coordinates in Notes without implicit variable decoration. An explicit whole-name variable preserves one reference wrapper, exact coloring, Space reveal in Variables, no hover popup and Meta definition dispatch.";
  await hosted.evaluate(() => {
    globalThis.document.body.classList.add("vscode-light");
    const style = globalThis.document.documentElement.style;
    style.setProperty("--vscode-editor-background", "#ffffff");
    style.setProperty("--vscode-editor-foreground", "#1d343f");
  });
  evidence.lightKeyword = await hosted
    .locator('.code-card[data-step="source-0"] .syntax-keyword')
    .first()
    .evaluate((node) => globalThis.getComputedStyle(node).color);
  assert.notEqual(evidence.lightKeyword, evidence.simulatedHost.keyword);
  await hosted.locator('[data-select="source-0"]').click();
  await hosted
    .locator('.code-card[data-step="source-0"]')
    .scrollIntoViewIfNeeded();
  await hosted.screenshot({
    path: path.join(artifacts, "syntax-host.png"),
  });
  assert.equal(await hosted.locator("#error").isVisible(), false);
  assert.deepEqual(errors, []);
  evidence.definitionRequests = requests;
  evidence.gestures =
    "Playwright right-click, Meta-click and keyboard Enter on nested syntax spans. Control-click uses a bubbling DOM click because macOS maps physical Control-click to contextmenu.";
  evidence.scope =
    "Actual Chrome and shared React with real service. VS Code host is simulated; definition lookup uses the real fallback, not an IDE language provider.";
  fs.writeFileSync(
    path.join(artifacts, "syntax-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n"
  );
  console.log(
    "PASS source syntax browser. JS/TS/JSX/TSX/Go coloring, full/focus text conservation, escaping, all original reference attributes, nested right-click/Control/Meta/Enter gestures and real definition insertions. VS Code transport is simulated, not a native IDE run."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
