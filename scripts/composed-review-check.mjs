import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readSavedStep, chooseReviewFile } from "./unified-review-check.mjs";
import {
  composeReviewFixture,
  reviewMarkdown,
} from "../tests/fixtures/composed-review.mjs";

// Same public authoring/reader seam in actual Chrome and the disposable native
// webview. The supplied fixture alone owns all source and Git mutations.
export async function verifyComposedReview(frame, f, label = "browser") {
  const { saved } = await composeReviewFixture(f);
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  const panel = frame.locator("#git-comparisons");
  await frame
    .locator(".current-source-choices")
    .getByRole("button", { name: "Changes", exact: true })
    .click();
  await chooseReviewFile(frame, "staged", "composed.ts");
  await panel
    .getByRole("heading", { name: "Composed Git review", exact: true })
    .waitFor();
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  assert.equal(
    await frame
      .locator('[data-current-side="before"] .function-context')
      .textContent(),
    "Multiple functions",
    "Full raw source cannot inherit the excerpt-only function name"
  );
  assert.equal(
    await frame.locator("#current-changes .current-columns pre").count(),
    2
  );
  await frame.locator(`[data-comparison-path="${saved.id}"]`).click();
  await readSavedStep(frame, "Common owner");
  const left = panel.locator(
    '[data-comparison-column="before"] .authored-card'
  );
  const right = panel.locator(
    '[data-comparison-column="after"] .authored-card'
  );
  for (const [cards, names] of [
    [left, ["beforeOrder", "beforeOrder › anonymous"]],
    [right, ["indexOrder", "indexOrder › anonymous"]],
  ]) {
    for (let index = 0; index < 2; index++) {
      await readSavedStep(frame, index ? "Nested owner" : "Common owner");
      const card = cards.first();
      assert.equal(
        await card.locator(".review-source > .function-context").textContent(),
        names[index]
      );
      assert.equal(
        await card
          .locator("pre .function-context, h3 .function-context")
          .count(),
        0
      );
      assert.equal(
        await card.locator("code[data-source-line]").count(),
        index ? 1 : 4
      );
      const source = await card.locator(".review-source").boundingBox();
      const purpose = await card.locator(".authored-purpose").boundingBox();
      assert.ok(source.y < purpose.y);
      for (const tab of ["Notes", "Variables"]) {
        await card.getByRole("button", { name: tab, exact: true }).click();
        const body = card.locator(".review-notes .markdown-body");
        assert.equal(await body.locator("h2").textContent(), "Side note");
        assert.equal(await body.locator("strong").textContent(), "Exact");
        assert.equal(await body.locator("del").textContent(), "old");
        assert.equal(await body.locator("li").count(), 2);
        assert.equal(
          await body.locator("img,script,iframe,style,a").count(),
          0
        );
        assert.ok(
          (await body.innerText()).includes(
            '<img src="https://invalid.example/comparison-image">'
          )
        );
        assert.ok((await body.innerText()).includes("alt only"));
      }
    }
  }
  await readSavedStep(frame, "Common owner");
  const before = left.first(),
    after = right.first();
  for (const card of [before, after]) {
    await card.getByRole("button", { name: "Variables", exact: true }).click();
    await card
      .locator(".review-notes .note")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
  }
  assert.equal(
    await before.getByLabel("Note text").inputValue(),
    reviewMarkdown
  );
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    reviewMarkdown
  );
  const edited = reviewMarkdown + "\n\n*Edited independently*";
  await before.getByLabel("Note text").fill(edited);
  await after.getByLabel("Note text").fill("**Independent after draft**");
  await before.getByRole("button", { name: "Save note", exact: true }).click();
  await before
    .locator(".markdown-body em")
    .getByText("Edited independently", { exact: true })
    .waitFor();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "**Independent after draft**"
  );
  // A concurrent side draft remains intact when its revision conflict is refused.
  await after.getByRole("button", { name: "Save note", exact: true }).click();
  await after.getByRole("alert").waitFor();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "**Independent after draft**"
  );
  await after
    .getByRole("button", { name: "Close editor", exact: true })
    .click();
  const read = await f.service.call("get_comparison_walkthrough", {
    id: saved.id,
  });
  const note = read.steps[0].annotations.notes.find(
    (note) => note.side === "before" && note.variableName
  );
  assert.equal(note.body, edited);
  assert.equal(note.history[0].body, reviewMarkdown);
  assert.equal(read.steps[0].before.code.functionContext.name, "beforeOrder");
  assert.equal(read.steps[0].after.code.functionContext.name, "indexOrder");
  const page = typeof frame.page === "function" ? frame.page() : frame;
  await page.setViewportSize({ width: 760, height: 900 });
  for (const zoom of [1, 1.25, 2]) {
    await frame.locator("body").evaluate((element, zoom) => {
      element.style.zoom = String(zoom);
    }, zoom);
    const geometry = await panel.evaluate((element) =>
      ["before", "after"].map((side) => {
        const r = element
          .querySelector(`[data-comparison-column="${side}"] .authored-card`)
          .getBoundingClientRect();
        return { x: r.x, y: r.y };
      })
    );
    const [a, b] = geometry;
    assert.ok(b.x > a.x && Math.abs(a.y - b.y) < 2);
    assert.ok(
      await panel
        .locator(".comparison-scroll")
        .evaluate((element) => element.scrollWidth > element.clientWidth)
    );
  }
  await frame.locator("body").evaluate((element) => {
    element.style.zoom = "1";
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await panel.evaluate((element) => {
    element.scrollTop = 0;
  });
  const output = path.resolve(
    process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/comparison-walkthrough"
  );
  fs.mkdirSync(output, { recursive: true });
  await panel.screenshot({ path: path.join(output, `composed-${label}.png`) });
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  console.log(
    `PASS ${label} composed B: raw-side selected function context, safe Markdown in both homes, raw/history/independent drafts, aligned narrow zoom.`
  );
}
