import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepath-ui-"));
fs.writeFileSync(path.join(root, "flow.ts"), "export const value = 1;\n");
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.join(base, "dist"),
  });
  for (const id of ["a", "b"]) {
    await service.call("save_walkthrough", {
      id,
      title: id.toUpperCase(),
      steps: [1, 2].map((number) => ({
        id: id + number,
        title: id + number,
        source: { file: "flow.ts", startLine: 1, endLine: 1 },
        evidence: "inferred",
        explanation: "Fixture",
      })),
    });
    await service.call("record_run", {
      walkthroughId: id,
      label: id + " saved run",
      mode: "example",
      origin: "UI regression fixture",
      events: [{ stepId: id + "1", input: { path: id }, output: { path: id } }],
    });
  }
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  async function assertPath(id, step = id + "1") {
    await page
      .locator('#paths button.selected[data-path="' + id + '"]')
      .waitFor();
    await page.locator('.code-card.active[data-step="' + step + '"]').waitFor();
    assert.equal(await page.locator("#error").isVisible(), false);
  }
  async function choose(id) {
    await page.locator('[data-path="' + id + '"]').click();
    await assertPath(id);
  }
  async function holdResponse(matches) {
    let release, received, finished;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const arrived = new Promise((resolve) => {
      received = resolve;
    });
    const completed = new Promise((resolve) => {
      finished = resolve;
    });
    let used = false;
    const handler = async (route) => {
      if (used || !matches(route.request())) return route.continue();
      used = true;
      const response = await route.fetch();
      received();
      await held;
      await route.fulfill({ response });
      finished();
    };
    await page.route("**/api/**", handler);
    return {
      arrived,
      async release() {
        const response = page.waitForResponse(matches);
        release();
        await Promise.all([completed, response]);
        await page.unroute("**/api/**", handler);
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              globalThis.requestAnimationFrame(() =>
                globalThis.requestAnimationFrame(resolve)
              )
            )
        );
      },
    };
  }
  const tool = (name, id) => (requestOrResponse) => {
    const request =
      typeof requestOrResponse.request === "function"
        ? requestOrResponse.request()
        : requestOrResponse;
    if (!request.url().endsWith("/api/call")) return false;
    const body = request.postDataJSON();
    return body.name === name && (!id || body.arguments.id === id);
  };

  await assertPath("a");
  await choose("b");
  const lateWalkthrough = await holdResponse(tool("get_walkthrough", "a"));
  await page.locator('[data-path="a"]').click();
  await lateWalkthrough.arrived;
  await choose("b");
  await lateWalkthrough.release();
  await page.waitForLoadState("networkidle");
  await assertPath("b");
  assert.match(await page.locator("#values").innerText(), /"b"/);

  const aRuns = await service.call("list_runs", { walkthroughId: "a" });
  const lateRun = await holdResponse(tool("get_run", aRuns[0].id));
  await page.locator('[data-path="a"]').click();
  await lateRun.arrived;
  await choose("b");
  await lateRun.release();
  await assertPath("b");
  assert.match(await page.locator("#values").innerText(), /"b"/);
  assert.doesNotMatch(await page.locator("#values").innerText(), /"a"/);

  await service.call("focus_step", { walkthroughId: "a", stepId: "a2" });
  const overview = await holdResponse(tool("project_overview"));
  await page.locator("#refresh").click();
  await overview.arrived;
  await choose("b");
  await page.evaluate(() => {
    globalThis.observedPaths = [];
    globalThis.pathObserver = new globalThis.MutationObserver(() => {
      globalThis.observedPaths.push(
        globalThis.document.querySelector("#paths button.selected")?.dataset
          .path
      );
    });
    globalThis.pathObserver.observe(
      globalThis.document.querySelector("#paths"),
      {
        attributes: true,
        subtree: true,
        attributeFilter: ["class"],
      }
    );
  });
  await service.call("focus_step", { walkthroughId: "b", stepId: "b1" });
  await overview.release();
  await page.waitForLoadState("networkidle");
  await assertPath("b");
  const observedPaths = await page.evaluate(() => {
    globalThis.pathObserver.disconnect();
    return globalThis.observedPaths;
  });
  assert.ok(
    observedPaths.every((id) => id === "b"),
    "A held overview must never navigate away from B"
  );
  await page.locator("#refresh").click();
  await assertPath("b");

  await page.locator("#notes-tab").click();
  await page
    .locator("#note-text")
    .fill("Draft survives tab changes and polling");
  await page.locator("#data-tab").click();
  await page.locator("#notes-tab").click();
  await service.call("add_note", {
    walkthroughId: "b",
    stepId: "b1",
    body: "Agent note while drafting",
    author: "Test",
  });
  await page.getByText("Agent note while drafting", { exact: true }).waitFor();
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "Draft survives tab changes and polling"
  );
  await page.locator('[data-select="b1"]').click();
  assert.equal(await page.locator("#note-text").inputValue(), "");

  await page.locator("#note-text").fill("First submitted body");
  const lateNote = await holdResponse(tool("add_note"));
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await lateNote.arrived;
  await page.getByText("First submitted body", { exact: true }).waitFor();
  await page.locator("#note-text").fill("New draft after saved note hydration");
  await lateNote.release();
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "New draft after saved note hydration"
  );

  await page.locator("#agent").click();
  await page.locator("#modal[open]").waitFor();
  await service.call("focus_step", { walkthroughId: "a", stepId: "a2" });
  const focusResponse = page.waitForResponse(
    (response) => response.request().postDataJSON()?.name === "project_overview"
  );
  await focusResponse;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve)
        )
      )
  );
  await assertPath("b");
  await page.locator("#close-modal").click();
  await assertPath("a", "a2");

  await page.locator("#data-tab").click();
  await page.locator("#runs").selectOption("example");
  await service.call("add_note", {
    walkthroughId: "a",
    stepId: "a2",
    body: "Refresh without changing manual run selection",
    author: "Test",
  });
  await page.locator("#refresh").click();
  await page.locator("#notes-tab").click();
  await page
    .getByText("Refresh without changing manual run selection", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#runs").inputValue(), "example");

  await choose("b");
  const deletedRead = await holdResponse(tool("get_walkthrough", "b"));
  await page.locator('[data-path="b"]').click();
  await deletedRead.arrived;
  await page.locator("#delete-path").click();
  await page.locator("#confirm-delete").waitFor();
  await service.call("add_note", {
    walkthroughId: "b",
    stepId: "b1",
    body: "Work added after the deletion review",
    author: "Test",
  });
  await page.locator("#confirm-delete").click();
  await page.locator("#review-delete").waitFor();
  assert.equal(await page.locator("#confirm-delete").isDisabled(), true);
  const preserved = await service.call("get_walkthrough", { id: "b" });
  assert.ok(
    preserved.steps[0].notes.some(
      (note) => note.body === "Work added after the deletion review"
    )
  );
  await page.locator("#review-delete").click();
  await page.locator("#confirm-delete:not([disabled])").waitFor();
  await page.locator("#confirm-delete").click();
  await assertPath("a");
  await deletedRead.release();
  await assertPath("a");
  assert.equal(await page.locator('[data-path="b"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "UI refactor browser regressions passed. Late walkthrough/run/overview replies, polling and delayed-save drafts, same-step reset, modal focus deferral, manual run selection and revision-safe deletion with an outstanding read use the real service."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
