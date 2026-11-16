import assert from "node:assert/strict";
import { authorReviewFlow } from "./review-flow-check.mjs";
import { allChanges } from "../tests/fixtures/git-project.mjs";
export async function verifyReviewComparisonFlow(frame, f) {
  const previousPath = (await frame.locator("[data-path].selected").count())
      ? await frame.locator("[data-path].selected").getAttribute("data-path")
      : null,
    previousStep = (await frame.locator(".code-card.active").count())
      ? await frame.locator(".code-card.active").getAttribute("data-step")
      : null;
  const { walk: initial, file } = await authorReviewFlow(f, {
    file: "review-comparison-flow.ts",
    branch: "review-comparison-flow-older",
  });
  await f.service.call("add_note", {
    walkthroughId: initial.id,
    stepId: "target-card",
    body: "Only the ordinary walkthrough note.",
    author: "Human",
  });
  const walk = await f.service.call("get_walkthrough", { id: initial.id }),
    list = await allChanges(f.service),
    item = list.files.find(
      (entry) => entry.file === file && entry.group === "unstaged"
    ),
    view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: item.id,
    });
  const create = (label) =>
    f.service.call("create_comparison_walkthrough", {
      title: "Review " + label,
      listId: list.listId,
      steps: [
        {
          id: "comparison-" + label,
          title: "Review the returned value",
          fileId: item.id,
          binding: view.binding,
          before: side(label + " before"),
          after: side(label + " after"),
        },
      ],
    });
  function side(label) {
    return {
      title: label,
      purpose: "Read the returned local value.",
      startLine: 80,
      endLine: 83,
      notes: [
        {
          body: "Only comparison " + label + " note.",
          startLine: 82,
          endLine: 82,
        },
      ],
      variables: [
        {
          name: "emoji",
          body: "The returned local value.",
          occurrences: [{ line: 82, startColumn: 9 }],
        },
      ],
    };
  }
  const a = await create("A"),
    b = await create("B");
  await frame.locator(`[data-path="${walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${walk.id}"]`).click();
  await frame.locator("#notes-tab").click();
  await frame.locator("#note-text").fill("Keep ordinary draft while reviewing");
  await frame.locator(`[data-comparison-path="${a.id}"]`).first().click();
  const root = frame.locator("#current-changes");
  await root.getByRole("button", { name: "Changes", exact: true }).click();
  await root
    .getByText("Only comparison A after note.", { exact: true })
    .waitFor();
  await root.locator(`[data-review-path="${file}"]`).waitFor();
  await root.locator(".git-file-list[data-inventory-ready=true]").waitFor();
  const toggle = frame.getByRole("button", { name: "Flow", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await frame.getByRole("button", { name: "Walkthrough", exact: true }).click();
  const flow = frame.locator("#review-flow-panel");
  try {
    await flow.locator('[data-flow-node="s0"]').waitFor({ timeout: 2000 });
  } catch (error) {
    throw new Error(
      "Existing Flow unavailable after comparison selection: " +
        (await frame.locator("#review-flow-canvas").innerText()),
      { cause: error }
    );
  }
  assert.equal(
    await frame
      .getByText("Flow is not available for this saved comparison.", {
        exact: true,
      })
      .count(),
    0
  );
  assert.equal(
    await frame.locator("[data-review-flow-owner]").innerText(),
    walk.title
  );
  assert.equal(
    await root.locator("[data-walkthrough-note-id]").count(),
    0,
    "Flow must not inject ordinary notes alongside selected comparison notes"
  );
  await flow.locator('[data-flow-node="s0"]').click();
  const article = root.locator(
      `[data-review-path="${file}"][data-review-active=true]`
    ),
    after = article.locator('[data-current-side="after"]');
  try {
    await after
      .locator("[data-flow-source]")
      .getByText("emoji", { exact: true })
      .waitFor();
  } catch (error) {
    throw new Error(
      "Exact Flow source did not settle: " +
        JSON.stringify({
          status: await frame.locator("[data-review-flow-status]").innerText(),
          activeFile: await root
            .locator("[data-review-active=true]")
            .getAttribute("data-review-path"),
          inventory: await root
            .locator(".git-file-list")
            .getAttribute("data-inventory-ready"),
        }),
      { cause: error }
    );
  }
  assert.equal(
    await article
      .locator('[data-current-side="before"] [data-flow-source]')
      .count(),
    0,
    "Same selected snippet in another whole-file version is not a match"
  );
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after
    .getByLabel("Note text")
    .fill("Keep comparison draft while using Flow");
  const page = typeof frame.page === "function" ? frame.page() : frame;
  await frame.evaluate(() => {
    globalThis.comparisonFlowMessage = null;
    globalThis.addEventListener("message", (event) => {
      if (event.data?.type === "codepath.flow.select")
        globalThis.comparisonFlowMessage = event.data;
    });
  });
  await flow.getByRole("button", { name: "Pop out Flow", exact: true }).click();
  let child;
  const deadline = Date.now() + 15000;
  while (!child && Date.now() < deadline) {
    for (const p of page.context().pages())
      for (const candidate of p.frames())
        if (await candidate.locator("#flow-window").count()) child = candidate;
    if (!child) await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.ok(child);
  assert.notEqual(child.page(), page);
  await child.locator('[data-flow-node="s1"]').click();
  await frame.waitForFunction(
    () => globalThis.document.querySelector("#review-flow-canvas").hidden
  );
  await after
    .locator("[data-flow-source]")
    .getByText("😀", { exact: true })
    .waitFor();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Keep comparison draft while using Flow"
  );
  const old = await frame.evaluate(() => globalThis.comparisonFlowMessage);
  assert.ok(old);
  // Same graph, same bytes, different annotation owners: reject a queued old
  // window selection, including A -> B -> A equal-ID/source recreation.
  for (const comparison of [b, a]) {
    await frame
      .locator(`[data-comparison-path="${comparison.id}"]`)
      .first()
      .click();
    await root
      .getByText(
        "Only comparison " +
          (comparison.id === a.id ? "A" : "B") +
          " after note.",
        { exact: true }
      )
      .waitFor();
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
      "Old comparison window action must not navigate a newer or equal-restored selection"
    );
  }
  await child.locator('[data-flow-node="s0"]').press("Escape");
  await child.locator('[data-flow-node="s0"]').press("Enter");
  await after
    .locator("[data-flow-source]")
    .getByText("emoji", { exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Keep comparison draft while using Flow"
  );
  assert.equal(await root.locator("[data-walkthrough-note-id]").count(), 0);
  await root.getByRole("button", { name: "Compare", exact: true }).click();
  await root.getByLabel("Current target", { exact: true }).selectOption("HEAD");
  await root
    .getByText("No allowed-path differences.", { exact: true })
    .waitFor();
  await child.locator('[data-flow-node="s0"]').press("Escape");
  await child.locator('[data-flow-node="s0"]').press("Enter");
  await frame
    .locator("[data-review-flow-status]")
    .getByText(/no exact source version/)
    .waitFor();
  assert.equal(await root.locator("[data-flow-source]").count(), 0);
  await child
    .getByRole("button", { name: "Close window", exact: true })
    .click();
  const end = Date.now() + 5000;
  while (!child.isDetached() && !child.page().isClosed() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(child.isDetached() || child.page().isClosed());
  assert.equal(await frame.locator("#review-flow-canvas").isVisible(), false);
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Keep ordinary draft while reviewing"
  );
  assert.deepEqual(
    await f.service.call("get_walkthrough", { id: walk.id }),
    walk
  );
  for (const record of [a, b])
    assert.deepEqual(
      await f.service.call("get_comparison_walkthrough", { id: record.id }),
      record
    );
  if (previousPath) {
    await frame.locator(`[data-path="${previousPath}"]`).click();
    if (previousStep)
      await frame.locator(`[data-select="${previousStep}"]`).click();
  }
  console.log(
    "PASS existing Flow across comparison-note selection: original graph/provenance, exclusive notes and both drafts, exact AFTER not wrong BEFORE, collapsed native/browser pop-out, A/B/A stale-window rejection, honest no-match, no graph/notes/progress mutations."
  );
}
