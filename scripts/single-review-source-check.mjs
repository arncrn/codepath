import assert from "node:assert/strict";
import { authorFixture } from "../tests/fixtures/authored-comparison.mjs";
import { chooseReviewFile } from "./unified-review-check.mjs";
export async function verifySingleReviewSource(frame, f) {
  const previousPath = (await frame.locator("[data-path].selected").count())
      ? await frame.locator("[data-path].selected").getAttribute("data-path")
      : null,
    previousStep = (await frame.locator(".code-card.active").count())
      ? await frame.locator(".code-card.active").getAttribute("data-step")
      : null;
  // authorFixture expects a committed part.ts BEFORE. Native starts from a
  // different owned disposable base than gitProject's browser fixture.
  try {
    f.git("cat-file", "-e", "HEAD:part.ts");
  } catch {
    f.write("part.ts", "const amount = 1;\nunchanged\n");
    f.git("add", "--", "part.ts");
    f.git(
      "commit",
      "--quiet",
      "-m",
      "single-source fixture base",
      "--only",
      "--",
      "part.ts"
    );
  }
  const { saved } = await authorFixture(f);
  const walk = await f.service.call("save_walkthrough", {
    title: "Actual selected walkthrough",
    steps: [
      {
        id: "actual",
        title: "Actual card",
        source: { file: "part.ts", startLine: 1, endLine: 4 },
        explanation: "Actual existing purpose",
      },
    ],
  });
  const note = await f.service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "actual",
    body: "This is the existing walkthrough note, not an extra comparison annotation.",
    author: "Human",
  });
  const original = await f.service.call("get_walkthrough", { id: walk.id });
  await frame.locator(`[data-path="${walk.id}"]`).waitFor();
  await frame.locator(`[data-path="${walk.id}"]`).click();
  await frame.locator("#notes-tab").click();
  await frame.locator("#note-text").fill("Keep ordinary draft");
  await frame
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await frame.locator('#current-changes').getByRole('button',{name:'Changes',exact:true}).click();
  await chooseReviewFile(frame, "unstaged", "part.ts");
  const panel = frame.locator("#current-changes");
  await panel
    .locator(
      `[data-review-active=true] [data-walkthrough-note-id="${note.id}"]`
    )
    .getByText(note.body, { exact: true })
    .waitFor();
  assert.equal(
    await panel.locator("[data-inline-explanation]").count(),
    0,
    "Normal Review changes must not automatically fetch/display another annotation collection"
  );
  assert.equal(
    await panel
      .getByText("Expanded saved calculation block behavior", { exact: true })
      .count(),
    0,
    "Do not stack extra comparison notes about the same code"
  );
  assert.equal(
    await panel.locator(".review-notes-heading").count(),
    0,
    "No repeated generic Before/After Notes-and-Variables headings"
  );
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Keep ordinary draft"
  );
  await frame.locator(`[data-comparison-path="${saved.id}"]`).first().click();
  await chooseReviewFile(frame, "unstaged", "part.ts");
  await panel
    .getByText("Expanded saved calculation block behavior", { exact: true })
    .waitFor();
  assert.equal(
    await panel.locator("[data-walkthrough-note-id]").count(),
    0,
    "Explicit alternate annotation selection is exclusive, never a silent mix"
  );
  const after = panel.locator(
    '[data-review-path="part.ts"][data-review-active=true] [data-current-side="after"]'
  );
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after.getByLabel("Note text").fill("Keep separately owned draft");
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  await frame
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await chooseReviewFile(frame, "unstaged", "part.ts");
  await panel
    .locator(
      `[data-review-active=true] [data-walkthrough-note-id="${note.id}"]`
    )
    .waitFor();
  assert.equal(await panel.locator("[data-inline-explanation]").count(), 0);
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  await frame.locator(`[data-comparison-path="${saved.id}"]`).first().click();
  await chooseReviewFile(frame, "unstaged", "part.ts");
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Keep separately owned draft",
    "Removing automatic mixing must not discard another owner's unsaved draft"
  );
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  assert.deepEqual(
    await f.service.call("get_walkthrough", { id: walk.id }),
    original
  );
  assert.equal(await panel.locator(".changed-file input:checked").count(), 0);
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  if (previousPath) {
    await frame.locator(`[data-path="${previousPath}"]`).click();
    if (previousStep)
      await frame.locator(`[data-select="${previousStep}"]`).click();
  }
  console.log(
    "PASS one explanation source: normal review shows original walkthrough only; explicit comparison selection never mixes originals; both independently owned drafts/data/IDs/manual Viewed retained."
  );
}
