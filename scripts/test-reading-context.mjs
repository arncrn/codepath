import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";
import {
  dispatchReadingContext,
  dispatchWebviewRequest,
  webviewHtml,
} from "../dist/vscode/bridge.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
// Keep macOS's Unix-domain IPC socket below its 103-character path limit.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
const desktop = process.argv.includes("--desktop");
const extensionPath = process.env.CODEPATH_TEST_EXTENSION_DIR ?? base;
let browser, child, exited;
const services = [];
async function fixture(name, port, focus = true) {
  const root = path.join(dir, name);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "flow.ts"), "export const value = 1;\n");
  const service = await startProjectService(root, {
    assetsRoot: path.join(base, "dist"),
    ...(port ? { port } : {}),
  });
  services.push(service);
  for (const id of ["a", "b"])
    await service.call("save_walkthrough", {
      id,
      title: id.toUpperCase(),
      steps: [1, 2, 3].map((i) => ({
        id: id + i,
        title: id + i,
        source: { file: "flow.ts", startLine: 1, endLine: 1 },
        evidence: "inferred",
        explanation: "Fixture",
      })),
    });
  if (focus)
    await service.call("focus_step", { walkthroughId: "a", stepId: "a1" });
  return service;
}
async function assertPosition(frame, walk, step, tab = "notes") {
  await frame
    .locator('#paths button.selected[data-path="' + walk + '"]')
    .waitFor();
  await frame.locator('.code-card.active[data-step="' + step + '"]').waitFor();
  assert.equal(
    await frame.locator("#" + tab + "-tab").getAttribute("class"),
    "active"
  );
  assert.equal(await frame.locator("#error").isVisible(), false);
}
async function choose(frame, walk = "b", step = "b2") {
  await frame.locator('[data-path="' + walk + '"]').click();
  await frame.locator('[data-select="' + step + '"]').click();
  await frame.locator("#notes-tab").click();
  await assertPosition(frame, walk, step);
  await delay(400); // allow the host storage response before disposing the panel
}
async function common(service, getFrame, reopen) {
  let frame = await getFrame();
  await frame.locator('[data-step="a1"]').waitFor();
  await choose(frame);
  await frame.locator("#note-text").fill("Unsaved draft must not persist");
  const revision = (await service.call("get_walkthrough", { id: "b" }))
    .revision;
  frame = await reopen();
  await assertPosition(frame, "b", "b2");
  assert.equal(await frame.locator("#note-text").inputValue(), "");
  assert.equal(
    (await service.call("get_walkthrough", { id: "b" })).revision,
    revision
  );
  await frame.locator("#variables-tab").click();
  await delay(400);
  frame = await reopen();
  await assertPosition(frame, "b", "b2", "variables");
  assert.equal(
    (await service.call("get_walkthrough", { id: "b" })).revision,
    revision,
    "Restoring Variables does not write learning data"
  );
  await frame.locator("#notes-tab").click();
  await delay(2300);
  await assertPosition(frame, "b", "b2"); // old persisted agent focus must not steal reading position
  await service.call("focus_step", { walkthroughId: "a", stepId: "a2" });
  await assertPosition(frame, "a", "a2"); // genuinely new focus is intentional
  await choose(frame);
  frame = await reopen();
  await assertPosition(frame, "b", "b2");
  let walk = await service.call("get_walkthrough", { id: "b" });
  await service.call("save_walkthrough", {
    ...walk,
    expectedRevision: walk.revision,
    steps: walk.steps.filter((s) => s.id !== "b2"),
  });
  frame = await reopen();
  await assertPosition(frame, "b", "b1");
  walk = await service.call("get_walkthrough", { id: "b" });
  await service.call("delete_walkthrough", {
    id: "b",
    expectedRevision: walk.revision,
  });
  frame = await reopen();
  await assertPosition(frame, "a", "a1");
  walk = await service.call("get_walkthrough", { id: "a" });
  await service.call("delete_walkthrough", {
    id: "a",
    expectedRevision: walk.revision,
  });
  frame = await reopen();
  await frame.locator(".welcome").waitFor();
  assert.equal(await frame.locator("#error").isVisible(), false);
}
try {
  const service = await fixture("one");
  if (!desktop) {
    browser = await chromium.launch({
      channel: process.env.CHROME_CHANNEL ?? "chrome",
      headless: true,
    });
    const context = await browser.newContext();
    let page = await context.newPage();
    const errors = [];
    context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
    await page.goto(service.url);
    await common(
      service,
      async () => page,
      async () => {
        await page.reload();
        return page;
      }
    );
    // Malformed browser storage is ignored, not surfaced as an application error.
    await page.evaluate(
      (root) =>
        globalThis.localStorage.setItem(
          "codepath.reading-context.v1:" + root,
          "{broken"
        ),
      service.root
    );
    await page.reload();
    await page.locator(".welcome").waitFor();
    await page.close();
    page = await context.newPage();
    await page.goto(service.url);
    await page.locator(".welcome").waitFor();
    // Same origin and profile, different real workspace: no context leakage.
    const port = Number(new URL(service.url).port);
    await service.close();
    const second = await fixture("two", port, false);
    await page.goto(second.url);
    await assertPosition(page, "a", "a1", "data");
    await choose(page);
    await page.close();
    page = await context.newPage();
    await page.goto(second.url);
    await assertPosition(page, "b", "b2");
    // A focus requested while the UI is closed is also NEW, not stale focus.
    await page.close();
    await second.call("focus_step", { walkthroughId: "a", stepId: "a3" });
    page = await context.newPage();
    await page.goto(second.url);
    await assertPosition(page, "a", "a3");
    assert.deepEqual(errors, []);
    // Real shared UI with the VS Code transport and CSP, but a simulated host.
    // This supplements (does not replace) the actual --desktop launch check.
    const hosted = await fixture("hosted");
    const hostValues = new Map();
    const hostState = {
      get: (key) => hostValues.get(key),
      update: async (key, value) => {
        hostValues.set(key, value);
      },
    };
    const hostContext = await browser.newContext();
    await hostContext.exposeBinding(
      "readingTestHost",
      async (_source, message) => {
        try {
          const result = message.route.startsWith("reading-context/")
            ? await dispatchReadingContext(
                hostState,
                hosted.root,
                message.route,
                message.body
              )
            : await dispatchWebviewRequest(hosted, message.route, message.body);
          return { type: "codepath.response", id: message.id, result };
        } catch (error) {
          return {
            type: "codepath.response",
            id: message.id,
            error: error.message,
          };
        }
      }
    );
    await hostContext.addInitScript(() => {
      globalThis.acquireVsCodeApi = () => ({
        postMessage: (message) => {
          globalThis
            .readingTestHost(message)
            .then((response) => globalThis.postMessage(response, "*"));
        },
      });
    });
    await hostContext.route("**/host-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: webviewHtml(
          fs.readFileSync(path.join(base, "dist/ui.html"), "utf8"),
          {
            styleUri: hosted.url + "/style.css",
            themeUri: hosted.url + "/style.css",
            scriptUri: hosted.url + "/ui.js",
            cspSource: hosted.url,
            config: { root: hosted.root, toolRoot: base, backend: "node" },
          }
        ),
      })
    );
    let hostPage = await hostContext.newPage();
    await hostPage.goto(hosted.url + "/host-test");
    await common(
      hosted,
      async () => hostPage,
      async () => {
        await hostPage.close();
        hostPage = await hostContext.newPage();
        await hostPage.goto(hosted.url + "/host-test");
        return hostPage;
      }
    );
    assert.equal(
      await hostPage.evaluate(() => globalThis.CODEPATH_TOKEN),
      undefined
    );
    await hostContext.close();
    console.log(
      "PASS simulated desktop bridge: real nonce-CSP UI, restricted transport, fresh webview recreation with host state, stale/new focus and deletion; no webview token."
    );
    console.log(
      "PASS browser: real refresh/reload, close/reopen, stale/new focus, deleted step/path/all, malformed state, same-origin root isolation, no revision writes."
    );
  } else {
    const executable =
      process.env.VSCODE_EXECUTABLE ??
      "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    child = spawn(
      executable,
      [
        "--new-window",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        "--disable-updates",
        "--user-data-dir=" + path.join(dir, "profile"),
        "--extensions-dir=" + path.join(dir, "extensions"),
        "--extensionDevelopmentPath=" + extensionPath,
        "--remote-debugging-port=" + port,
        service.root,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let logs = "";
    child.stdout.on("data", (d) => {
      logs += d;
    });
    child.stderr.on("data", (d) => {
      logs += d;
    });
    exited = new Promise((resolve) => {
      child.on("exit", resolve);
      child.on("error", resolve);
    });
    for (let i = 0; i < 100; i++) {
      try {
        browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
        break;
      } catch {
        await delay(200);
      }
    }
    assert.ok(browser, "VS Code debugging endpoint");
    const workbench = () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("workbench"));
    async function command(label) {
      let page;
      for (let i = 0; i < 200; i++) {
        if (child.exitCode !== null) break;
        page = workbench();
        if (page && (await page.locator(".monaco-workbench").count())) break;
        await delay(100);
      }
      assert.ok(
        page,
        "VS Code workbench must load: " +
          browser
            .contexts()
            .flatMap((c) => c.pages())
            .map((p) => p.url())
            .join(", ") +
          "\n" +
          logs
      );
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+Shift+p" : "Control+Shift+p"
      );
      const input = page.locator(".quick-input-widget input");
      await input.fill(">" + label);
      // Search results update asynchronously; Enter can invoke the previous
      // selection before the requested extension command has appeared.
      const option = page
        .locator(".quick-input-list .monaco-list-row")
        .filter({ hasText: label })
        .first();
      await option.waitFor({ state: "visible" });
      await option.click();
      await delay(700);
    }
    async function frame() {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        for (const page of browser.contexts().flatMap((c) => c.pages()))
          for (const candidate of page.frames()) {
            try {
              await candidate
                .locator("#rail")
                .waitFor({ state: "attached", timeout: 300 });
              return candidate;
            } catch (error) {
              if (error.name !== "TimeoutError" && !candidate.isDetached())
                throw error;
            }
          }
        await delay(100);
      }
      throw Error("Codepath webview did not render");
    }
    await command("Codepath: Open Walkthroughs");
    await choose(await frame());
    await command("Developer: Reload Window");
    await command("Codepath: Open Walkthroughs");
    await assertPosition(await frame(), "b", "b2");
    await service.call("focus_step", { walkthroughId: "a", stepId: "a1" });
    await assertPosition(await frame(), "a", "a1");
    await common(service, frame, async () => {
      await command("View: Close Editor");
      await command("Codepath: Open Walkthroughs");
      return frame();
    });
    console.log(
      "PASS desktop: rendered VS Code panel dispose/recreate, host workspaceState, stale/new focus, deleted step/path/all, no revision writes."
    );
  }
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (exited) await Promise.race([exited, delay(5000)]);
  await Promise.allSettled(services.map((s) => s.close()));
  fs.rmSync(dir, { recursive: true, force: true });
}
