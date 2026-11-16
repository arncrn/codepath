import assert from "node:assert/strict";
import fs from "node:fs";
import { authorReviewFlow } from "./review-flow-check.mjs";
export async function verifyAfterFlow(frame, f) {
  const previousPath = (await frame.locator("[data-path].selected").count())
      ? await frame.locator("[data-path].selected").getAttribute("data-path")
      : null,
    previousStep = (await frame.locator(".code-card.active").count())
      ? await frame.locator(".code-card.active").getAttribute("data-step")
      : null;
  const { walk, file } = await authorReviewFlow(f, {
    file: "after-flow-target.ts",
    branch: "after-flow-older",
  });
  await frame.locator(`[data-path="${walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${walk.id}"]`).click();
  await frame.locator("#notes-tab").click();
  await frame.locator("#note-text").fill("Keep draft through After Flow");
  await frame
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const root = frame.locator("#current-changes");
  await root.getByRole("button", { name: "Changes", exact: true }).click();
  await root.locator(`[data-review-path="${file}"]`).waitFor();
  await root.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  const toggle = frame.getByRole("button", { name: "Flow", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await frame
    .getByRole("button", { name: "After", exact: true })
    .click({ timeout: 2000 });
  await frame.locator('[data-flow-after-state="ready"]').waitFor();
  const flow = frame.locator("#review-flow-panel");
  await flow.locator('[data-flow-node="s0"]').waitFor();
  assert.equal(
    await flow.locator("[data-flow-node]").count(),
    walk.flowState.nodes.length,
    "After proves the entire graph; it never filters to matching fragments"
  );
  await flow.locator('[data-flow-node="s0"]').press("Enter");
  const mark = root.locator(
    `[data-review-path="${file}"][data-review-active=true] [data-current-side="after"] [data-flow-source]`
  );
  await mark.getByText("emoji", { exact: true }).waitFor();
  assert.equal(
    await root
      .locator('[data-current-side="before"] [data-flow-source]')
      .count(),
    0
  );
  // Mode-only unstaged pair has identical Before/After bytes. After must
  // choose saved working source and must still never highlight Before.
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
  await flow.locator('[data-flow-node="s0"]').press("Escape");
  await flow.locator('[data-flow-node="s0"]').press("Enter");
  await root
    .locator(
      `[data-review-path="${file}"][data-review-group="unstaged"][data-review-active=true] [data-current-side="after"] [data-flow-source]`
    )
    .getByText("emoji", { exact: true })
    .waitFor();
  assert.equal(
    await root
      .locator('[data-current-side="before"] [data-flow-source]')
      .count(),
    0,
    "Identical Before bytes do not make Before an After target"
  );
  const page = typeof frame.page === "function" ? frame.page() : frame;
  await frame.evaluate(() => {
    globalThis.afterFlowMessage = null;
    globalThis.addEventListener("message", (event) => {
      if (event.data?.type === "codepath.flow.select")
        globalThis.afterFlowMessage = event.data;
    });
  });
  await flow.getByRole("button", { name: "Pop out Flow", exact: true }).click();
  let child;
  const end = Date.now() + 15000;
  while (!child && Date.now() < end) {
    for (const p of page.context().pages())
      for (const c of p.frames())
        if (await c.locator("#flow-window").count()) child = c;
    if (!child) await new Promise((r) => setTimeout(r, 80));
  }
  assert.ok(child);
  await child
    .locator("[data-flow-window-source]")
    .filter({ hasText: "After" })
    .waitFor();
  await frame.waitForFunction(
    () => globalThis.document.querySelector("#review-flow-canvas").hidden
  );
  await child.locator('[data-flow-node="s1"]').press("Enter");
  await root
    .locator('[data-current-side="after"] [data-flow-source]')
    .getByText("😀", { exact: true })
    .waitFor();
  await child.locator('[data-flow-node="s1"]').hover();
  await child
    .getByRole("dialog", { name: "Flow code preview", exact: true })
    .locator(".flow-preview-location")
    .filter({ hasText: "After source" })
    .waitFor();
  const old = await frame.evaluate(() => globalThis.afterFlowMessage);
  assert.ok(old);
  f.git(
    "commit",
    "--quiet",
    "-m",
    "After Flow current version",
    "--only",
    "--",
    file
  );
  const browserHost = await frame.evaluate(
    () => globalThis.window.CODEPATH_CONFIG.host !== "vscode"
  );
  let release,
    announce,
    complete,
    held = false;
  const gate = new Promise((r) => (release = r)),
    seen = new Promise((r) => (announce = r)),
    finished = new Promise((r) => (complete = r));
  const intercept = async (route) => {
    const data = route.request().postDataJSON();
    if (
      !held &&
      data?.name === "list_git_changes" &&
      data.arguments?.query?.mode === "compare"
    ) {
      held = true;
      try {
        const response = await route.fetch();
        announce();
        await gate;
        await route.fulfill({ response });
      } finally {
        complete();
      }
    } else await route.continue();
  };
  if (browserHost) await page.route("**/api/call", intercept);
  try {
    await root.getByRole("button", { name: "Compare", exact: true }).click();
    if (browserHost) {
      await seen;
      await frame.locator('[data-flow-after-state="checking"]').waitFor();
      await child
        .locator("[data-flow-node]")
        .first()
        .waitFor({ state: "detached" });
      assert.equal(
        await root.locator("[data-flow-source]").count(),
        0,
        "Old inventory cannot keep an After proof alive under a new target"
      );
    }
  } finally {
    release();
    if (browserHost && held) await finished;
    if (browserHost) await page.unroute("**/api/call", intercept);
  }
  await root
    .getByLabel("Current target", { exact: true })
    .selectOption("refs/heads/after-flow-older");
  await frame.locator('[data-flow-after-state="unavailable"]').waitFor();
  await child.getByText(/does not match After source/).waitFor();
  assert.equal(
    await child.locator("[data-flow-node]").count(),
    0,
    "A graph matching only BEFORE must not be shown as AFTER"
  );
  assert.equal(await root.locator("[data-flow-source]").count(), 0);
  await child
    .getByText(/After Flow/)
    .first()
    .waitFor();
  await root
    .getByLabel("Current target", { exact: true })
    .selectOption("WORKING_TREE");
  await root
    .getByLabel("Current base branch", { exact: true })
    .selectOption("refs/heads/after-flow-older");
  await frame.locator('[data-flow-after-state="ready"]').waitFor();
  await child.locator('[data-flow-node="s0"]').waitFor();
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
        globalThis.window.opener.postMessage(data, globalThis.location.origin),
      old
    );
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    await root.locator("[data-flow-source]").count(),
    0,
    "Equal restored After bytes must not revive old source focus or accept an old window packet"
  );
  await child.locator('[data-flow-node="s0"]').press("Escape");
  await child.locator('[data-flow-node="s0"]').press("Enter");
  await mark.getByText("emoji", { exact: true }).waitFor();
  assert.equal(
    await root
      .locator('[data-current-side="before"] [data-flow-source]')
      .count(),
    0
  );
  await child
    .getByRole("button", { name: "Close window", exact: true })
    .click();
  const close = Date.now() + 5000;
  while (!child.isDetached() && !child.page().isClosed() && Date.now() < close)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(child.isDetached() || child.page().isClosed());
  assert.equal(await frame.locator("#review-flow-canvas").isVisible(), false);
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Keep draft through After Flow"
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
    "PASS After Flow: explicit side, complete diagram proof, After-only source/Unicode navigation and detached provenance, no Before fallback, mismatch refusal and equal-restored lifetime, popup collapse, original diagram/draft unchanged."
  );
}
