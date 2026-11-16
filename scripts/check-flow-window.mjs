import assert from "node:assert/strict";
import { verifyFlowZoom } from "./check-flow-zoom.mjs";
import { setTimeout as delay } from "node:timers/promises";

// Same public UI seam in real Chrome AND real native auxiliary editor windows.
export async function verifyFlowWindow(service, main) {
  const page = typeof main.page === "function" ? main.page() : main;
  const context = page.context();
  await main.locator('[data-select="run"]').click();
  await main.locator("#notes-tab").click();
  await main.locator("#note-text").fill("Pop-out must keep my unsaved draft");
  await main.locator("#flow-tab").click();
  await main.locator("#flow-panel svg .node").first().waitFor();
  const revision = (await service.call("get_walkthrough", { id: "semantic" }))
    .revision;
  const viewport = () =>
    main.evaluate(() =>
      ["#workspace", ".walkthrough-flow"].map((s) => {
        const e = globalThis.document.querySelector(s),
          r = e.getBoundingClientRect();
        return [e.scrollLeft, e.scrollTop, r.x, r.y];
      })
    );
  await main
    .getByRole("button", { name: "Pop out Flow", exact: true })
    .scrollIntoViewIfNeeded();
  await main.evaluate(
    () =>
      new Promise((r) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(r)
        )
      )
  );
  const before = await viewport();
  await main.evaluate(() => {
    globalThis.lastFlowSelect = null;
    globalThis.window.addEventListener("message", (e) => {
      if (e.data?.type === "codepath.flow.select")
        globalThis.lastFlowSelect = e.data;
    });
  });
  await main.getByRole("button", { name: "Pop out Flow", exact: true }).click();
  let popup;
  const until = Date.now() + 15000;
  while (!popup && Date.now() < until) {
    for (const p of context.pages())
      for (const frame of p.frames())
        if (await frame.locator("#flow-window").count()) popup = frame;
    if (!popup) await delay(80);
  }
  assert.ok(popup, "Pop out opens a separate browser/native window");
  const native = await main.evaluate(
    () => globalThis.window.CODEPATH_CONFIG.host === "vscode"
  );
  assert.notEqual(
    popup.page(),
    page,
    "Native must use auxiliary OS window, not just another tab"
  );
  await popup.locator("#flow-panel svg .node").first().waitFor();
  assert.equal(
    await popup.locator("#flow-panel > p").count(),
    0,
    "Current popout also omits instruction/summary text"
  );
  assert.equal(
    await popup.locator("#flow-panel svg .node").count(),
    12,
    "Entire Flow, not a single-node inspector"
  );
  assert.equal(
    await popup.locator("#rail").count(),
    0,
    "Do not duplicate reading cards/drafts"
  );
  assert.equal(
    await popup
      .getByRole("button", { name: "Pop out Flow", exact: true })
      .count(),
    0,
    "No recursive pop-outs"
  );
  assert.deepEqual(
    await viewport(),
    before,
    "Opening leaves original reader page and graph in place"
  );
  await verifyFlowZoom(popup, main);
  const target = popup.locator('[data-flow-node="s10"]');
  await target.scrollIntoViewIfNeeded();
  await popup.evaluate(
    () =>
      new Promise((r) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(r)
        )
      )
  );
  await popup.page().mouse.move(1, 1);
  await target.hover();
  const preview = popup.getByRole("dialog", {
    name: "Flow code preview",
    exact: true,
  });
  await preview.waitFor();
  assert.equal(
    await preview
      .locator("[data-flow-source]")
      .allTextContents()
      .then((a) => a.join("")),
    "helper(n - 1)"
  );
  assert.equal(
    await main.locator(".code-card.active").getAttribute("data-step"),
    "run",
    "Hover in pop-out does not navigate reader"
  );
  await target.press("Escape");
  await preview.waitFor({ state: "detached" });
  await target.click();
  await main
    .locator('.code-card.active[data-step="helper"] [data-flow-source]')
    .first()
    .waitFor({ timeout: 6000 });
  assert.deepEqual(
    await viewport(),
    before,
    "Click in pop-out selects/highlights original card without moving its page/diagram"
  );
  const old = await main.evaluate(() => globalThis.lastFlowSelect);
  assert.ok(old);
  // Return through the pop-out's flow action, not ordinary step navigation
  // (which has its own existing draft-reset policy).
  await popup.locator('[data-flow-node="s0"]').click();
  await main.locator('.code-card.active[data-step="run"]').waitFor();
  await main.locator("#notes-tab").click();
  assert.equal(
    await main.locator("#note-text").inputValue(),
    "Pop-out must keep my unsaved draft"
  );
  await main.locator("#flow-tab").click();
  if (!native) {
    await popup.page().reload();
    await popup.locator("#flow-panel svg .node").first().waitFor();
    await popup.evaluate(
      (data) =>
        globalThis.window.opener.postMessage(data, globalThis.location.origin),
      old
    );
    await delay(250);
    assert.equal(
      await main.locator(".code-card.active").getAttribute("data-step"),
      "run",
      "Reloading same popup creates a new view lifetime; old queued actions cannot revive"
    );
  }
  // Navigation stays ephemeral: switching guides retires old messages, even if
  // the old saved IDs/source bytes later return equal.
  await main.locator('[data-path="a"]').click();
  await popup
    .getByText("Flow has not been authored for this walkthrough.", {
      exact: true,
    })
    .waitFor();
  await main.locator('[data-path="semantic"]').click();
  await main.locator("#flow-tab").click();
  await popup.locator("#flow-panel svg .node").first().waitFor();
  await main.locator('[data-select="run"]').click();
  if (native)
    await main.evaluate(
      (data) =>
        globalThis.window.dispatchEvent(
          new globalThis.MessageEvent("message", { data })
        ),
      old
    );
  else
    await popup.evaluate(
      (data) =>
        globalThis.window.opener.postMessage(data, globalThis.location.origin),
      old
    );
  await delay(250);
  assert.equal(
    await main.locator(".code-card.active").getAttribute("data-step"),
    "run",
    "Late old-view selection cannot revive after equal-source restoration"
  );
  await main.locator("#notes-tab").click();
  await main.locator("#flow-tab").click();
  await popup
    .getByRole("button", { name: "Close window", exact: true })
    .click();
  const end = Date.now() + 5000;
  while (!popup.isDetached() && !popup.page().isClosed() && Date.now() < end)
    await delay(50);
  assert.ok(
    popup.isDetached() || popup.page().isClosed(),
    "Close only the Flow window"
  );
  if (!native) {
    await main.evaluate(() => {
      const open = globalThis.window.open;
      globalThis.restoreFlowOpen = () => {
        globalThis.window.open = open;
      };
      globalThis.window.open = () => null;
    });
    await main
      .getByRole("button", { name: "Pop out Flow", exact: true })
      .click();
    await main
      .locator("#error")
      .filter({ hasText: "blocked the Flow window" })
      .waitFor();
    await main.evaluate(() => globalThis.restoreFlowOpen());
    await main.locator("#error").click();
  }
  await main.getByRole("button", { name: "Pop out Flow", exact: true }).click();
  let reopened;
  const reopenDeadline = Date.now() + 15000;
  while (!reopened && Date.now() < reopenDeadline) {
    for (const p of context.pages())
      for (const f of p.frames())
        if (await f.locator("#flow-window").count()) reopened = f;
    if (!reopened) await delay(80);
  }
  assert.ok(reopened, "Closing/reopening creates a fresh Flow connection");
  await reopened.locator("#flow-panel svg .node").first().waitFor();
  await reopened
    .getByRole("button", { name: "Close window", exact: true })
    .click();
  assert.equal(
    (await service.call("get_walkthrough", { id: "semantic" })).revision,
    revision,
    "Pop-out and navigation do not write learning data"
  );
  await main.locator("#notes-tab").click();
  await main.locator("#note-text").fill("");
  await main.locator("#flow-tab").click();
  await main.locator("#flow-tab").focus();
}
