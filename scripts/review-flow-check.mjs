/* global document, requestAnimationFrame -- Native/browser DOM callbacks. */
import assert from "node:assert/strict";
export async function authorReviewFlow(
  f,
  { file = "review-flow-target.ts", branch = "review-flow-older" } = {}
) {
  const lines = Array.from({ length: 120 }, (_, i) => `// context ${i + 1}`);
  lines[9] = "export const changed = 1;";
  lines[79] = "export function target() {";
  lines[80] = "  const emoji = '😀';";
  lines[81] = "  return emoji;";
  lines[82] = "}";
  f.write(file, lines.join("\n") + "\n");
  f.git("add", "--", file);
  f.git("commit", "--quiet", "-m", "review Flow fixture", "--only", "--", file);
  f.git("branch", branch);
  lines[9] = "export const changed = 2;";
  f.write(file, lines.join("\n") + "\n");
  const walk = await f.service.call("save_walkthrough", {
    title: "Existing Flow for review",
    steps: [
      {
        id: "target-card",
        title: "Return the named value",
        source: { file, startLine: 80, endLine: 83 },
        explanation: "Return the local value.",
      },
    ],
  });
  const code = walk.steps[0].code,
    range = (line, start, end) => ({
      file,
      fileHash: code.fileHash,
      startLine: line,
      endLine: line,
      startColumn: start,
      endColumn: end,
      text: code.lines[line - 1].slice(start, end),
    }),
    a = range(82, 9, 14),
    start = code.lines[80].indexOf("😀"),
    b = range(81, start, start + 2);
  await f.service.call("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph: {
      version: 1,
      summary: "Read and return the local value.",
      nodes: [
        {
          id: "return",
          kind: "exit",
          label: "Return the value",
          stepId: "target-card",
          sourceHash: code.hash,
          attachment: a,
        },
        {
          id: "emoji",
          kind: "process",
          label: "Read the Unicode value",
          stepId: "target-card",
          sourceHash: code.hash,
          attachment: b,
        },
      ],
      edges: [
        {
          from: "emoji",
          to: "return",
          kind: "next",
          label: "",
          basis: "The declaration precedes the return.",
        },
      ],
    },
  });
  return {
    walk: await f.service.call("get_walkthrough", { id: walk.id }),
    file,
    lines,
  };
}
export async function verifyReviewFlow(frame, f, { popup = false } = {}) {
  const previousPath = (await frame.locator("[data-path].selected").count())
      ? await frame.locator("[data-path].selected").getAttribute("data-path")
      : null,
    previousStep = (await frame.locator(".code-card.active").count())
      ? await frame.locator(".code-card.active").getAttribute("data-step")
      : null;
  const { walk, file, lines } = await authorReviewFlow(f);
  await frame.locator(`[data-path="${walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${walk.id}"]`).click();
  await frame.locator("#notes-tab").click();
  await frame
    .locator("#note-text")
    .fill("Ordinary draft stays independent of review Flow");
  await frame
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const root = frame.locator("#current-changes");
  await root.getByRole("button", { name: "Changes", exact: true }).click();
  await root.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  await frame.getByRole("button", { name: "Flow", exact: true }).click();
  await frame.getByRole("button", { name: "Walkthrough", exact: true }).click();
  const flow = frame.locator("#review-flow-panel");
  await flow.locator('[data-flow-node="s0"]').waitFor({ timeout: 15000 });
  const baselineViewed = await root
    .locator(".changed-file input:checked")
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("aria-label")).sort()
    );
  const svg = await flow.locator("svg").elementHandle();
  await root
    .getByRole("checkbox", { name: "Show only changed sections", exact: true })
    .check();
  const node = flow.locator('[data-flow-node="s0"]'),
    before = await flow.boundingBox();
  await node.press("Enter");
  const article = root.locator(
      `[data-review-path="${file}"][data-review-active=true]`
    ),
    mark = article.locator('[data-current-side="after"] [data-flow-source]');
  await mark.waitFor();
  assert.equal(await mark.textContent(), "emoji");
  assert.equal(
    await article
      .locator('[data-current-side="before"] [data-flow-source]')
      .count(),
    0,
    "Equal selected snippet in BEFORE is not whole-file source correspondence"
  );
  assert.ok(
    (await article
      .locator('[data-current-side="after"] code[data-source-line="10"]')
      .count()) > 0,
    "Every current hunk remains visible"
  );
  assert.equal(
    await article
      .locator('[data-current-side="after"] code[data-source-line="82"]')
      .count(),
    1,
    "Flow range included even outside changed windows"
  );
  assert.equal(
    await mark.evaluate((n) =>
      n.closest(".line").classList.contains("diff-added")
    ),
    false,
    "Do not invent a change at the Flow location"
  );
  const after = await flow.boundingBox();
  assert.ok(
    Math.abs(before.y - after.y) < 1 &&
      Math.abs(before.height - after.height) < 1,
    "Flow stays fixed while only the comparison reader reveals source"
  );
  assert.equal(await node.evaluate((n) => n === document.activeElement), true);
  assert.equal(
    await svg.evaluate(
      (old, current) => old === current,
      await flow.locator("svg").elementHandle()
    ),
    true,
    "Source selection must not redraw Mermaid"
  );
  const revealed = await mark.evaluate(
    (n) =>
      new Promise((resolve) => {
        const deadline = performance.now() + 2000;
        const check = () => {
          const box = n.getBoundingClientRect(),
            outer = n.closest("#current-changes").getBoundingClientRect();
          if (
            n.isConnected &&
            box.top >= outer.top &&
            box.bottom <= outer.bottom
          )
            return resolve(true);
          if (performance.now() >= deadline) return resolve(false);
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      })
  );
  assert.ok(
    revealed,
    "Product-owned reveal reaches the real viewport within its animation frames, without QA scrolling"
  );
  const geometry = await mark.boundingBox(),
    clip = await root.boundingBox();
  assert.ok(
    geometry.y >= clip.y &&
      geometry.y + geometry.height <= clip.y + clip.height,
    "Exact marked text is actually in the comparison viewport"
  );
  const panes = await mark.evaluate((n) => {
    const a = [];
    for (const selector of [
      ".code",
      ".comparison-scroll",
      "#current-changes",
    ]) {
      const r = n.closest(selector).getBoundingClientRect();
      a.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    const r = n.getBoundingClientRect();
    return {
      panes: a,
      mark: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    };
  });
  assert.ok(
    panes.mark.left >= Math.max(...panes.panes.map((r) => r.left)) - 1 &&
      panes.mark.right <= Math.min(...panes.panes.map((r) => r.right)) + 1,
    "Mark is inside actual root, pair, and code horizontal clips"
  );
  assert.deepEqual(
    await root
      .locator(".changed-file input:checked")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("aria-label")).sort()
      ),
    baselineViewed,
    "Flow preserves existing manual Viewed marks; it does not require a clean progress fixture"
  );
  await flow.locator('[data-flow-node="s1"]').click();
  await article
    .locator("[data-flow-source]")
    .getByText("😀", { exact: true })
    .waitFor();
  {
    const page = typeof frame.page === "function" ? frame.page() : frame;
    await frame.evaluate(() => {
      globalThis.reviewFlowOldSelect = null;
      globalThis.addEventListener("message", (event) => {
        if (event.data?.type === "codepath.flow.select")
          globalThis.reviewFlowOldSelect = event.data;
      });
    });
    await flow
      .getByRole("button", { name: "Pop out Flow", exact: true })
      .click();
    let child;
    const deadline = Date.now() + 15000;
    while (!child && Date.now() < deadline) {
      for (const p of page.context().pages())
        for (const candidate of p.frames())
          if (await candidate.locator("#flow-window").count())
            child = candidate;
      if (!child) await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.ok(child, "Separate browser/native Flow window opens from review");
    assert.notEqual(
      child.page(),
      page,
      "Use a separate OS/browser window, not a duplicated reader"
    );
    await child.locator('[data-flow-node="s0"]').waitFor();
    await frame.waitForFunction(
      () => globalThis.document.querySelector("#review-flow-canvas").hidden
    );
    assert.equal(
      await flow.count(),
      0,
      "Successful browser/native pop-out removes inline review diagram"
    );
    assert.ok(
      (await root.boundingBox()).height - clip.height > 100,
      "Reader gains the inline diagram space"
    );
    await child.locator('[data-flow-node="s0"]').click();
    await mark.getByText("emoji", { exact: true }).waitFor();
    const old = await frame.evaluate(() => globalThis.reviewFlowOldSelect);
    assert.ok(old);
    await child.evaluate(() => {
      globalThis.reviewFlowEpochs = [];
      globalThis.addEventListener("message", (event) => {
        if (
          event.data?.type === "codepath.flow.state" &&
          !globalThis.reviewFlowEpochs.includes(event.data.epoch)
        )
          globalThis.reviewFlowEpochs.push(event.data.epoch);
      });
    });
    await frame
      .getByRole("button", { name: "Back to walkthrough", exact: true })
      .click();
    await frame
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await child.waitForFunction(() => globalThis.reviewFlowEpochs.length >= 2);
    await root.locator(".git-file-list[data-inventory-ready=true]").waitFor();
    const native = await frame.evaluate(
      () => globalThis.window.CODEPATH_CONFIG.host === "vscode"
    );
    if (native)
      await frame.evaluate(
        (data) =>
          globalThis.dispatchEvent(
            new globalThis.MessageEvent("message", { data })
          ),
        old
      );
    else
      await child.evaluate(
        (data) =>
          globalThis.window.opener.postMessage(
            data,
            globalThis.location.origin
          ),
        old
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      await root.locator("[data-flow-source]").count(),
      0,
      "Old detached review selection cannot revive after equal-ID/source reader/review recreation"
    );
    await child.locator('[data-flow-node="s1"]').click();
    await root
      .locator('[data-current-side="after"] [data-flow-source]')
      .getByText("😀", { exact: true })
      .waitFor();
    await child
      .getByRole("button", { name: "Close window", exact: true })
      .click();
    const end = Date.now() + 5000;
    while (!child.isDetached() && !child.page().isClosed() && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(child.isDetached() || child.page().isClosed());
    assert.equal(
      await frame.locator("#review-flow-canvas").isVisible(),
      false,
      "Closing the window leaves inline Flow collapsed"
    );
    await frame.getByRole("button", { name: "Flow", exact: true }).click();
    await flow.locator('[data-flow-node="s0"]').waitFor();
  }
  if (popup) {
    const page = typeof frame.page === "function" ? frame.page() : frame;
    let release,
      announce,
      held = false;
    const gate = new Promise((resolve) => (release = resolve)),
      seen = new Promise((resolve) => (announce = resolve));
    const intercept = async (route) => {
      if (!held && route.request().postDataJSON()?.name === "get_git_file") {
        held = true;
        const response = await route.fetch();
        announce();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    };
    await page.route("**/api/call", intercept);
    try {
      await node.click();
      await seen;
      await frame.getByRole("button", { name: "Flow", exact: true }).click();
      await frame.getByRole("button", { name: "Flow", exact: true }).click();
      await flow.locator('[data-flow-node="s0"]').waitFor();
      release();
      await page.waitForTimeout(250);
      assert.equal(
        await root.locator("[data-flow-source]").count(),
        0,
        "Accepted late source read cannot revive hidden/recreated Flow intent"
      );
    } finally {
      release();
      await page.unroute("**/api/call", intercept);
    }
    const sourcePosition = await root.evaluate((n) => [
      n.scrollTop,
      n.scrollLeft,
    ]);
    await flow.locator('[data-flow-node="s1"]').hover();
    const preview = frame.getByRole("dialog", {
      name: "Flow code preview",
      exact: true,
    });
    await preview.waitFor();
    assert.match(
      await preview.locator(".flow-preview-location").innerText(),
      /Walkthrough source/
    );
    assert.deepEqual(
      await root.evaluate((n) => [n.scrollTop, n.scrollLeft]),
      sourcePosition
    );
    assert.equal(
      await root.locator("[data-flow-source]").count(),
      0,
      "Hover is read-only and does not select a source"
    );
    await preview.press("Escape");
    await node.click();
    await mark.waitFor();
  }
  // Same graph version appears as staged AFTER and in a mode-only unstaged
  // pair. It is not permissible to silently choose one by pathname/order.
  const fs = await import("node:fs");
  const rootPath = f.git("rev-parse", "--show-toplevel").toString().trim();
  f.git("add", "--", file);
  fs.chmodSync(rootPath + "/" + file, 0o755);
  await root
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await root
    .locator(`[data-review-path="${file}"][data-review-group="staged"]`)
    .waitFor();
  await root
    .locator(`[data-review-path="${file}"][data-review-group="unstaged"]`)
    .waitFor();
  await root.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  await node.click();
  try {
    await frame
      .locator("[data-review-flow-status]")
      .getByText(/multiple compared pairs/)
      .waitFor();
  } catch (error) {
    throw new Error(
      "Ambiguous-pair UI did not settle: " +
        JSON.stringify({
          status: await frame.locator("[data-review-flow-status]").innerText(),
          pairs: await root
            .locator(`[data-review-path="${file}"]`)
            .evaluateAll((nodes) =>
              nodes.map((n) => [n.dataset.reviewGroup, n.dataset.reviewActive])
            ),
          sourceStatus: await flow.innerText(),
        }),
      { cause: error }
    );
  }
  assert.equal(
    await root.locator("[data-flow-source]").count(),
    0,
    "Ambiguous staged/unstaged path never chooses a pair automatically"
  );
  await frame
    .locator("[data-review-flow-status]")
    .getByRole("button", { name: new RegExp("^staged · after · " + file) })
    .click();
  await root
    .locator(
      `[data-review-group="staged"][data-review-active=true] [data-current-side="after"] [data-flow-source]`
    )
    .getByText("emoji", { exact: true })
    .waitFor();
  // Commit that exact source, then compare it against the older branch: the
  // same authored graph now has an exact BEFORE home, not an invented AFTER.
  f.git(
    "commit",
    "--quiet",
    "-m",
    "review Flow current source",
    "--only",
    "--",
    file
  );
  await root.getByRole("button", { name: "Compare", exact: true }).click();
  await root
    .getByLabel("Current target", { exact: true })
    .selectOption("refs/heads/review-flow-older");
  await root.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  await node.click();
  await root
    .locator(
      `[data-review-active=true] [data-current-side="before"] [data-flow-source]`
    )
    .getByText("emoji", { exact: true })
    .waitFor();
  assert.equal(
    await root
      .locator('[data-current-side="after"] [data-flow-source]')
      .count(),
    0
  );
  await root.getByRole("button", { name: "Compare", exact: true }).click();
  await root.getByLabel("Current target", { exact: true }).selectOption("HEAD");
  await root
    .getByText("No allowed-path differences.", { exact: true })
    .waitFor();
  await node.click();
  await frame
    .locator("[data-review-flow-status]")
    .getByText(/no exact source version/i)
    .waitFor();
  assert.equal(await root.locator("[data-flow-source]").count(), 0);
  assert.equal(
    await root.locator(".code pre").count(),
    0,
    "Do not substitute walkthrough source for missing compared code"
  );
  // A stale graph then equal-byte restoration retires the old selection; it
  // does not resurrect marks or a queued source jump under the same IDs.
  lines[81] = "  return 42;";
  f.write(file, lines.join("\n") + "\n");
  await flow.locator("svg").waitFor({ state: "detached", timeout: 10000 });
  assert.equal(await root.locator("[data-flow-source]").count(), 0);
  lines[81] = "  return emoji;";
  f.write(file, lines.join("\n") + "\n");
  await flow.locator('[data-flow-node="s0"]').waitFor({ timeout: 10000 });
  assert.equal(
    await root.locator("[data-flow-source]").count(),
    0,
    "Equal restored bytes do not reuse a previous Flow-selection lifetime"
  );
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Ordinary draft stays independent of review Flow"
  );
  assert.deepEqual(
    await f.service.call("get_walkthrough", { id: walk.id }),
    walk
  );
  if (previousPath) {
    await frame.locator(`[data-path="${previousPath}"]`).click();
    if (previousStep)
      await frame.locator(`[data-select="${previousStep}"]`).click();
  }
  console.log(
    "PASS review Flow: exact AFTER and BEFORE/fullfile+UTF16 proof, explicit ambiguous-pair choice, focused unchanged target+all hunks, real local reveal with fixed diagram/focus/SVG, no wrong marks/progress/draft/data writes, honest no-match/empty comparison" +
      (popup ? ", detached source navigation." : ".")
  );
  return { walk, file };
}
