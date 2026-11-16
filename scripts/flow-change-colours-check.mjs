/* global getComputedStyle -- Actual browser/native geometry and colour checks. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { authorReviewFlow } from "./review-flow-check.mjs";
export async function verifyFlowChangeColours(frame, f) {
  const previousPath = (await frame.locator("[data-path].selected").count())
      ? await frame.locator("[data-path].selected").getAttribute("data-path")
      : null,
    previousStep = (await frame.locator(".code-card.active").count())
      ? await frame.locator(".code-card.active").getAttribute("data-step")
      : null;
  const { walk: initial, file } = await authorReviewFlow(f, {
      file: "flow-change-colours.ts",
      branch: "flow-change-colours-older",
    }),
    expanded = await f.service.call("save_walkthrough", {
      id: initial.id,
      expectedRevision: initial.revision,
      title: "Changed and unchanged Flow regions",
      steps: [
        {
          id: "target-card",
          title: "Unchanged returned value",
          source: { file, startLine: 80, endLine: 83 },
          explanation: "Keep returning the local value.",
        },
        {
          id: "changed-line",
          title: "Changed constant",
          source: { file, startLine: 10, endLine: 10 },
          explanation: "Use the new constant.",
        },
      ],
    }),
    code = expanded.steps.find((s) => s.id === "changed-line").code;
  await f.service.call("save_walkthrough_flow", {
    walkthroughId: expanded.id,
    expectedRevision: expanded.revision,
    graph: {
      ...initial.flow,
      nodes: [
        ...initial.flow.nodes,
        {
          id: "changed",
          kind: "process",
          label: "Changed constant line",
          stepId: "changed-line",
          sourceHash: code.hash,
          attachment: {
            file,
            fileHash: code.fileHash,
            startLine: 10,
            endLine: 10,
            startColumn: 0,
            endColumn: code.lines[9].length,
            text: code.lines[9],
          },
        },
      ],
    },
  });
  const walk = await f.service.call("get_walkthrough", { id: expanded.id });
  await frame.locator(`[data-path="${walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${walk.id}"]`).click();
  await frame.locator("#notes-tab").click();
  await frame
    .locator("#note-text")
    .fill("Keep draft while highlighting Flow changes");
  await frame
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const root = frame.locator("#current-changes");
  await root.getByRole("button", { name: "Changes", exact: true }).click();
  await root.locator(`[data-review-path="${file}"]`).waitFor();
  const toggle = frame.getByRole("button", { name: "Flow", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await frame.getByRole("button", { name: "After", exact: true }).click();
  await frame.locator('[data-flow-after-state="ready"]').waitFor();
  const flow = frame.locator("#review-flow-panel");
  await flow.locator('[data-flow-node="s2"]').waitFor();
  await flow.getByRole("button", { name: "Fit diagram", exact: true }).click();
  const visible = await flow
    .locator('[data-flow-node="s2"]')
    .evaluate((node) => {
      const r = node.getBoundingClientRect(),
        p = node.closest(".walkthrough-flow").getBoundingClientRect();
      return (
        r.left >= p.left - 1 &&
        r.right <= p.right + 1 &&
        r.top >= p.top - 1 &&
        r.bottom <= p.bottom + 1
      );
    });
  assert.ok(
    visible,
    "Changed node is genuinely visible inside its fitted graph clip, without QA scrolling"
  );
  assert.equal(
    await flow
      .locator('[data-flow-node="s2"]')
      .getAttribute("data-flow-change"),
    "changed",
    "The changed linked line needs a distinct visual category"
  );
  assert.equal(
    await flow
      .locator('[data-flow-node="s0"]')
      .getAttribute("data-flow-change"),
    "unchanged",
    "Do not colour every node in a modified file"
  );
  assert.equal(
    await flow
      .locator('[data-flow-node="s1"]')
      .getAttribute("data-flow-change"),
    "unchanged"
  );
  const legend = flow.getByRole("group", {
    name: "Flow change legend",
    exact: true,
  });
  await legend.waitFor();
  const fill = (scope) =>
      scope
        .locator("rect,polygon,circle,path")
        .first()
        .evaluate((n) => getComputedStyle(n).fill),
    changed = await fill(flow.locator('[data-flow-node="s2"]')),
    unchanged = await fill(flow.locator('[data-flow-node="s0"]'));
  assert.notEqual(
    changed,
    unchanged,
    "Computed native/browser fills, not just classes, must differ"
  );
  assert.equal(
    await legend
      .locator('[data-flow-change="changed"]')
      .evaluate((n) => getComputedStyle(n).backgroundColor),
    changed,
    "Legend matches rendered node colour"
  );
  assert.match(
    await flow
      .locator('[data-flow-node="s2"]')
      .getAttribute("aria-description"),
    /Changed/
  );
  const svg = await flow.locator("svg").elementHandle();
  await flow.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert.equal(
    await svg.evaluate(
      (old, current) => old === current,
      await flow.locator("svg").elementHandle()
    ),
    true
  );
  await flow.locator('[data-flow-node="s2"]').press("Enter");
  await root
    .locator('[data-current-side="after"] [data-flow-source]')
    .first()
    .waitFor();
  assert.equal(await fill(flow.locator('[data-flow-node="s2"]')), changed);
  const page = typeof frame.page === "function" ? frame.page() : frame;
  await flow.getByRole("button", { name: "Pop out Flow", exact: true }).click();
  let child;
  const until = Date.now() + 15000;
  while (!child && Date.now() < until) {
    for (const p of page.context().pages())
      for (const c of p.frames())
        if (await c.locator("#flow-window").count()) child = c;
    if (!child) await new Promise((r) => setTimeout(r, 80));
  }
  assert.ok(child);
  await child
    .locator('[data-flow-node="s2"][data-flow-change="changed"]')
    .waitFor();
  assert.equal(await fill(child.locator('[data-flow-node="s2"]')), changed);
  assert.equal(await fill(child.locator('[data-flow-node="s0"]')), unchanged);
  await child
    .getByRole("group", { name: "Flow change legend", exact: true })
    .waitFor();
  await frame.waitForFunction(
    () => globalThis.document.querySelector("#review-flow-canvas").hidden
  );
  await child.locator('[data-flow-node="s0"]').press("Enter");
  await root
    .locator('[data-current-side="after"] [data-flow-source]')
    .getByText("emoji", { exact: true })
    .waitFor();
  assert.equal(
    await root
      .locator('[data-current-side="before"] [data-flow-source]')
      .count(),
    0
  );
  // Same After bytes, new Before/pair: mode-only unstaged now has no changed
  // source lines; comparison against HEAD must restore only the real delta.
  f.git("add", "--", file);
  fs.chmodSync(
    f.git("rev-parse", "--show-toplevel").toString().trim() + "/" + file,
    0o755
  );
  await root
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await root
    .locator(`[data-review-path="${file}"][data-review-group="staged"]`)
    .waitFor();
  await root
    .locator(`[data-review-path="${file}"][data-review-group="unstaged"]`)
    .waitFor();
  await frame.locator('[data-flow-after-state="ready"]').waitFor();
  await child
    .locator('[data-flow-node="s2"][data-flow-change="unchanged"]')
    .waitFor();
  assert.equal(
    await child.locator('[data-flow-change="changed"][data-flow-node]').count(),
    0,
    "Old colour must not survive a new Before snapshot"
  );
  await root.getByRole("button", { name: "Compare", exact: true }).click();
  await frame.locator('[data-flow-after-state="ready"]').waitFor();
  await child
    .locator('[data-flow-node="s2"][data-flow-change="changed"]')
    .waitFor();
  assert.equal(
    await child
      .locator('[data-flow-node="s0"]')
      .getAttribute("data-flow-change"),
    "unchanged"
  );
  await frame.getByRole("button", { name: "Walkthrough", exact: true }).click();
  await child
    .locator("[data-flow-window-source]")
    .filter({ hasText: "Separate Flow window" })
    .waitFor();
  await child
    .getByRole("group", { name: "Flow change legend", exact: true })
    .waitFor({ state: "detached" });
  await child.locator('[data-flow-node="s2"]').waitFor();
  assert.equal(
    await child.locator("[data-flow-node][data-flow-change]").count(),
    0,
    "Change colours belong to certified After comparison, not generic Flow"
  );
  assert.equal(
    await child
      .getByRole("group", { name: "Flow change legend", exact: true })
      .count(),
    0
  );
  await child
    .getByRole("button", { name: "Close window", exact: true })
    .click();
  const end = Date.now() + 5000;
  while (!child.isDetached() && !child.page().isClosed() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(child.isDetached() || child.page().isClosed());
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Keep draft while highlighting Flow changes"
  );
  assert.deepEqual(
    await f.service.call("get_walkthrough", { id: walk.id }),
    walk
  );
  if (previousPath) {
    // Cleanup only: the native auxiliary window can leave the main webview
    // narrow enough that its existing responsive sidebar is hidden. All colour,
    // navigation and clipping checks above used real visible controls.
    const previous = frame.locator(`[data-path="${previousPath}"]`);
    if (await previous.isVisible()) await previous.click();
    else await previous.evaluate((button) => button.click());
    if (previousStep) {
      const step = frame.locator(`[data-select="${previousStep}"]`);
      await step.waitFor({ state: "attached" });
      if (await step.isVisible()) await step.click();
      else await step.evaluate((button) => button.click());
    }
  }
  console.log(
    "PASS Flow change colours: real changed/unchanged nodes within one modified file, native/browser computed fills and matching legend/accessibility, zoom/selection no redraw, popup parity/After-only navigation, recolour on Before-only change, generic Flow reset, draft/graph/progress unchanged."
  );
}
