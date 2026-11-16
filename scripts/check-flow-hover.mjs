import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Actual browser AND native public UI seam. Hover is not reading navigation.
export async function verifyFlowHover(service, frame, walk) {
  const preview = frame.getByRole("dialog", {
    name: "Flow code preview",
    exact: true,
  });
  const node = frame.locator('#flow-panel [data-flow-node="s10"]');
  await node.scrollIntoViewIfNeeded();
  await frame
    .locator("#flow-tab")
    .evaluate((e) => e.focus({ preventScroll: true }));
  await frame.evaluate(
    () =>
      new Promise((r) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(r)
        )
      )
  );
  await (typeof frame.page === "function" ? frame.page() : frame).mouse.move(
    1,
    1
  );
  const snapshot = () =>
    frame.evaluate(() => ({
      card: globalThis.document.querySelector(".code-card.active").dataset.step,
      marks: globalThis.document.querySelectorAll("#rail [data-flow-source]")
        .length,
      scroll: ["#workspace", "#rail", ".walkthrough-flow"].map((s) => {
        const e = globalThis.document.querySelector(s);
        return [e.scrollLeft, e.scrollTop];
      }),
      panes: [...globalThis.document.querySelectorAll("#rail .code")].map(
        (e) => [e.scrollLeft, e.scrollTop]
      ),
      active: globalThis.document.activeElement.id,
    }));
  const before = await snapshot(),
    svg = await frame.locator("#flow-panel svg").elementHandle(),
    revision = (await service.call("get_walkthrough", { id: walk.id }))
      .revision;
  await node.hover();
  await preview.waitFor({ timeout: 3000 });
  assert.match(await preview.innerText(), /helper.mjs/);
  assert.equal(
    await preview
      .locator("[data-flow-source]")
      .allTextContents()
      .then((a) => a.join("")),
    "helper(n - 1)"
  );
  assert.deepEqual(
    await snapshot(),
    before,
    "Hover changes neither reading selection, marks, scroll nor focus"
  );
  assert.equal(
    await svg.evaluate(
      (a, b) => a === b,
      await frame.locator("#flow-panel svg").elementHandle()
    ),
    true
  );
  const bounds = await preview.boundingBox();
  assert.ok(bounds.width > 150 && bounds.height > 60);
  await preview.hover();
  await delay(300);
  assert.equal(
    await preview.isVisible(),
    true,
    "Preview remains while moving pointer into it to read/copy/scroll"
  );
  await frame.evaluate(() => {
    const timer = globalThis.setTimeout;
    globalThis.hoverCloseJobs = [];
    globalThis.setTimeout = (fn, ms, ...args) =>
      ms === 180
        ? (globalThis.hoverCloseJobs.push(() => fn(...args)), 0)
        : timer(fn, ms, ...args);
    globalThis.restoreHoverClose = () => {
      globalThis.setTimeout = timer;
    };
  });
  await preview.evaluate((e) => {
    e.dispatchEvent(
      new globalThis.PointerEvent("pointerout", {
        bubbles: true,
        relatedTarget: globalThis.document.body,
      })
    );
    e.dispatchEvent(
      new globalThis.PointerEvent("pointerover", {
        bubbles: true,
        relatedTarget: globalThis.document.body,
      })
    );
  });
  await frame.evaluate(() => {
    globalThis.restoreHoverClose();
    for (const job of globalThis.hoverCloseJobs) job();
  });
  assert.equal(
    await preview.isVisible(),
    true,
    "Canceled old close callbacks must not dismiss a re-entered popup"
  );
  await preview
    .getByRole("button", { name: "Close code preview", exact: true })
    .click();
  await preview.waitFor({ state: "detached" });
  // Focus-only preview is accessible without selecting a node or moving page.
  await frame.locator("#flow-tab").focus();
  await node.focus();
  await preview.waitFor();
  await preview.locator(".code").click();
  await frame.waitForFunction(
    () =>
      globalThis.document.querySelector("[data-flow-code-preview] .code") ===
      globalThis.document.activeElement,
    undefined,
    { timeout: 3000 }
  );
  assert.equal(
    await preview
      .locator(".code")
      .evaluate((e) => e === globalThis.document.activeElement),
    true
  );
  await preview.evaluate((e) =>
    e.dispatchEvent(
      new globalThis.PointerEvent("pointerout", {
        bubbles: true,
        relatedTarget: globalThis.document.body,
      })
    )
  );
  await delay(220);
  assert.equal(
    await preview.isVisible(),
    true,
    "Keyboard-focused preview stays open when the mouse leaves it"
  );
  await preview.locator(".code").press("Escape");
  await preview.waitFor({ state: "detached" });
  assert.equal(
    await node.evaluate((e) => e === globalThis.document.activeElement),
    true,
    "Explicit dismissal returns focus without scrolling"
  );
  assert.equal((await snapshot()).card, before.card);
  assert.deepEqual((await snapshot()).scroll, before.scroll);
  // Scroll retires preview/anchor; returning to equal geometry cannot revive it.
  await frame
    .locator("#flow-tab")
    .evaluate((e) => e.focus({ preventScroll: true }));
  await (typeof frame.page === "function" ? frame.page() : frame).mouse.move(
    1,
    1
  );
  await node.hover();
  await preview.waitFor();
  await frame.evaluate(() => {
    const graph = globalThis.document.querySelector(".walkthrough-flow");
    graph.scrollTop += graph.scrollTop > 0 ? -10 : 10;
  });
  await preview.waitFor({ state: "detached" });
  await delay(300);
  assert.equal(await preview.count(), 0);
  // View hide/reopen also retires focus/hover previews.
  await node.focus();
  await preview.waitFor();
  await frame.locator("#notes-tab").click();
  await preview.waitFor({ state: "detached" });
  await frame.locator("#flow-tab").click();
  await delay(300);
  assert.equal(
    await preview.count(),
    0,
    "Hidden preview cannot revive when restored"
  );
  assert.equal(
    (await service.call("get_walkthrough", { id: walk.id })).revision,
    revision,
    "Preview is read-only"
  );
  await frame.locator("#flow-tab").focus();
  // Replay delayed hover work after hide/reopen, even if clearTimeout loses a race.
  await frame.evaluate(() => {
    const timer = globalThis.setTimeout;
    globalThis.hoverJobs = [];
    globalThis.setTimeout = (fn, ms, ...args) =>
      ms === 160
        ? (globalThis.hoverJobs.push(() => fn(...args)), 0)
        : timer(fn, ms, ...args);
    globalThis.restoreHoverTimer = () => {
      globalThis.setTimeout = timer;
    };
  });
  await node.dispatchEvent("pointerenter");
  await frame.locator("#notes-tab").click();
  await frame.locator("#flow-tab").click();
  await frame.evaluate(() => {
    globalThis.restoreHoverTimer();
    for (const job of globalThis.hoverJobs) job();
  });
  await delay(200);
  assert.equal(
    await preview.count(),
    0,
    "Queued hidden hover cannot revive in a recreated view lifetime"
  );
  await verifyHoverBounds(service, frame, walk.id);
}

async function verifyHoverBounds(service, frame, restoreId) {
  const file = path.join(service.root, "hover-boundary.mjs");
  const original =
    Array.from(
      { length: 100 },
      (_, i) => `const item${i} = "<img src=x onerror=alert(1)> 😀";`
    ).join("\n") +
    "\n//" +
    "z".repeat(66000) +
    "\n";
  async function guide(content, id, startLine, endLine, endColumn) {
    fs.writeFileSync(file, content);
    const w = await service.call("save_walkthrough", {
      id,
      title: "Preview boundary fixture",
      steps: [
        {
          id: "range",
          title: "Preview linked range",
          source: {
            file: "hover-boundary.mjs",
            startLine: 1,
            endLine: content.split("\n").length - 1,
          },
          explanation: "Fixture source",
          evidence: "inferred",
        },
      ],
    });
    const code = w.steps[0].code,
      text = code.lines
        .slice(startLine - 1, endLine)
        .map((s, i) => (i === endLine - startLine ? s.slice(0, endColumn) : s))
        .join("\n");
    await service.call("save_walkthrough_flow", {
      walkthroughId: id,
      expectedRevision: w.revision,
      graph: {
        version: 1,
        summary: "Source preview fixture",
        nodes: [
          {
            id: "range",
            kind: "process",
            label: "Literal source preview",
            stepId: "range",
            sourceHash: code.hash,
            attachment: {
              file: code.file,
              fileHash: code.fileHash,
              startLine,
              startColumn: 0,
              endLine,
              endColumn,
              text,
            },
          },
        ],
        edges: [],
      },
    });
    await frame.locator("#refresh").click();
    await frame.locator(`[data-path="${id}"]`).click();
    await frame.locator("#flow-tab").click();
    const node = frame.locator('#flow-panel [data-flow-node="s0"]');
    await node.waitFor();
    await node.scrollIntoViewIfNeeded();
    await node.focus();
    const preview = frame.getByRole("dialog", {
      name: "Flow code preview",
      exact: true,
    });
    await preview.waitFor();
    return { node, preview };
  }
  const { preview } = await guide(
    original,
    "hover-bounds",
    3,
    90,
    original.split("\n")[89].length
  );
  assert.equal(
    await preview.locator("code[data-source-line]").count(),
    60,
    "Long ranges show an explicitly bounded preview, never an unbounded file"
  );
  assert.match(await preview.innerText(), /Preview shows lines 1–60 only/);
  assert.equal(
    await preview.locator("img,script").count(),
    0,
    "Literal source never becomes markup"
  );
  await preview.locator(".code").evaluate((e) => {
    e.scrollTop = 100;
  });
  await delay(200);
  assert.equal(
    await preview.isVisible(),
    true,
    "Scrolling INSIDE popup keeps it open"
  );
  fs.writeFileSync(file, original + "// source changed\n");
  await frame.locator("#refresh").evaluate((e) => e.click());
  await preview.waitFor({ state: "detached" });
  fs.writeFileSync(file, original);
  await frame.locator("#refresh").evaluate((e) => e.click());
  await frame.locator("#flow-panel svg .node").waitFor();
  await delay(200);
  assert.equal(
    await preview.count(),
    0,
    "Restoring equal source cannot revive a stale hover"
  );
  const large = await guide(
    'const text = "' + "x".repeat(25000) + '";\n',
    "hover-byte-bound",
    1,
    1,
    5
  );
  assert.match(
    await large.preview.innerText(),
    /too large for a hover preview/
  );
  assert.equal(
    await large.preview.locator("code[data-source-line]").count(),
    0,
    "Oversized line is refused, not silently rewritten/truncated"
  );
  await large.preview
    .getByRole("button", { name: "Close code preview", exact: true })
    .click();
  await frame.locator(`[data-path="${restoreId}"]`).click();
  await frame.locator("#flow-tab").click();
  await frame.locator("#flow-panel svg .node").first().waitFor();
  await frame.locator("#flow-tab").focus();
  for (const id of ["hover-bounds", "hover-byte-bound"]) {
    const w = await service.call("get_walkthrough", { id });
    await service.call("delete_walkthrough", {
      id,
      expectedRevision: w.revision,
    });
  }
  fs.unlinkSync(file);
}
