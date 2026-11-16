import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

export async function assertNoDataUi(frame) {
  assert.equal(
    await frame
      .locator("#data-tab,#data-panel,#data-badge,#runs,#run-file,#import-run")
      .count(),
    0,
    "Removed Data UI must not remain mounted, even hidden"
  );
  assert.equal(
    await frame
      .getByRole("button", { name: "Data at this step", exact: true })
      .count(),
    0
  );
  assert.equal(
    await frame
      .getByRole("button", { name: "Import JSON", exact: true })
      .count(),
    0
  );
  for (const id of ["notes-tab", "variables-tab", "flow-tab"])
    assert.equal(await frame.locator("#" + id).isVisible(), true);
}
export async function verifyNoDataUi(frame, f) {
  const previousPath = (await frame.locator("[data-path].selected").count())
    ? await frame.locator("[data-path].selected").getAttribute("data-path")
    : null;
  const previousStep = (await frame.locator(".code-card.active").count())
    ? await frame.locator(".code-card.active").getAttribute("data-step")
    : null;
  f.write("preserved-data.ts", "export const amount = 1;\n");
  const walk = await f.service.call("save_walkthrough", {
    id: "preserved-data",
    title: "Saved values stay intact",
    steps: [
      {
        id: "one",
        title: "First step",
        source: { file: "preserved-data.ts", startLine: 1, endLine: 1 },
        explanation: "Read the amount.",
        sample: { input: { quantity: 2 }, output: { amount: 24 } },
      },
      {
        id: "two",
        title: "Second step",
        source: { file: "preserved-data.ts", startLine: 1, endLine: 1 },
        explanation: "Retain values.",
        sample: { input: 0, output: null },
      },
    ],
  });
  const runs = [];
  for (const mode of ["example", "recorded"])
    runs.push(
      await f.service.call("record_run", {
        walkthroughId: walk.id,
        label: mode + " kept",
        mode,
        origin: "Owned retained-data fixture",
        events: [
          {
            stepId: "one",
            sourceHash: walk.steps[0].code.fileHash,
            input: { mode },
            output: { kept: true },
          },
        ],
      })
    );
  const original = await f.service.call("get_walkthrough", { id: walk.id });
  const bytes = () =>
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(f.root + "/.codepaths/workspace.json"))
        .digest("hex"),
    before = bytes();
  await frame.locator(`[data-path="${walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${walk.id}"]`).click();
  if (
    await frame
      .getByRole("button", { name: "Back to walkthrough", exact: true })
      .isVisible()
  )
    await frame
      .getByRole("button", { name: "Back to walkthrough", exact: true })
      .click();
  await frame.locator(".code-card.active[data-step=one]").waitFor();
  await assertNoDataUi(frame);
  await frame.locator("#notes-tab").click();
  await frame
    .locator("#note-text")
    .fill("Notes draft unaffected by Data UI removal");
  await frame.locator("#variables-tab").click();
  await frame.locator("#flow-tab").click();
  await frame.locator("#notes-tab").click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Notes draft unaffected by Data UI removal"
  );
  await frame.locator("#refresh").click();
  await frame
    .locator(".refresh-status")
    .filter({ hasText: /^Refreshed$/ })
    .waitFor();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Notes draft unaffected by Data UI removal"
  );
  await frame.locator("[data-select=two]").click();
  await frame.locator(".code-card.active[data-step=two]").waitFor();
  await assertNoDataUi(frame);
  await frame
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await frame.locator("#current-changes[data-inventory-ready=true]").waitFor();
  assert.equal(
    await frame.locator("#data-tab,#data-panel,#run-file,#import-run").count(),
    0
  );
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.deepEqual(
    await f.service.call("get_walkthrough", { id: walk.id }),
    original
  );
  for (const run of runs)
    assert.deepEqual(await f.service.call("get_run", { id: run.id }), run);
  assert.equal(
    bytes(),
    before,
    "Removing the surface must not migrate/delete/update saved samples or runs"
  );
  if (previousPath) {
    const path = frame.locator(`[data-path="${previousPath}"]`);
    if (await path.isVisible()) await path.click();
    else await path.evaluate((n) => n.click());
    if (previousStep) {
      const step = frame.locator(`[data-select="${previousStep}"]`);
      await step.waitFor({ state: "attached" });
      if (await step.isVisible()) await step.click();
      else await step.evaluate((n) => n.click());
    }
  }
  console.log(
    "PASS no Data UI: no mounted tab/panel/selector/import, Notes/Variables/Flow/review/Refresh and draft retained, both saved run modes and samples exact, workspace bytes unchanged."
  );
}
