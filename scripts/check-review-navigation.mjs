import assert from "node:assert/strict";
import { selectedReviewFile } from "./unified-review-check.mjs";

// Same real browser/native UI seam. Reclaim width without retiring source/editor
// lifetimes or remounting the checklist and its manual progress controls.
export async function verifyReviewNavigation(frame) {
  const panel = frame.locator("#current-changes"),
    aside = frame.locator("aside"),
    list = panel.locator(".git-file-list"),
    host = panel.locator(".current-diff-host");
  const hide = frame.getByRole("button", {
    name: "Hide navigation",
    exact: true,
  });
  await hide.waitFor({ timeout: 3000 });
  const before = await host.boundingBox(),
    listHandle = await list.elementHandle(),
    asideHandle = await aside.elementHandle(),
    source = await selectedReviewFile(frame)
      .locator(".current-columns,.saved-versions")
      .first()
      .elementHandle();
  const editors = await host.locator("textarea").elementHandles(),
    drafts = await Promise.all(editors.map((e) => e.inputValue()));
  const progress = () =>
    list.locator('input[type="checkbox"]').evaluateAll((es) =>
      es.map((e) => ({
        label: e.getAttribute("aria-label"),
        checked: e.checked,
        disabled: e.disabled,
      }))
    );
  const original = await progress(),
    selected = await list.locator('[aria-current="true"]').allTextContents();
  const scroll = await list.evaluate((e) => {
    e.scrollTop = 40;
    return e.scrollTop;
  });
  assert.equal(await hide.getAttribute("aria-expanded"), "true");
  await hide.click();
  const show = frame.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  await show.waitFor();
  assert.equal(await show.getAttribute("aria-expanded"), "false");
  assert.equal(await aside.isVisible(), false);
  assert.equal(await list.isVisible(), false);
  assert.equal(await listHandle.evaluate((e) => e.isConnected), true);
  assert.equal(await asideHandle.evaluate((e) => e.isConnected), true);
  const wide = await host.boundingBox();
  assert.ok(
    wide.width > before.width + 150,
    `Real source width must grow: ${before.width} -> ${wide.width}`
  );
  assert.deepEqual(await progress(), original);
  assert.deepEqual(
    await Promise.all(editors.map((e) => e.inputValue())),
    drafts
  );
  assert.equal(
    await source.evaluate(
      (old, current) => old === current,
      await selectedReviewFile(frame)
        .locator(".current-columns,.saved-versions")
        .first()
        .elementHandle()
    ),
    true,
    "Keep exact source DOM, not just equal text"
  );
  await show.press("Enter");
  await hide.waitFor();
  assert.equal(await aside.isVisible(), true);
  assert.equal(await list.isVisible(), true);
  assert.ok(Math.abs((await host.boundingBox()).width - before.width) < 2);
  assert.equal(await listHandle.evaluate((e) => e.scrollTop), scroll);
  assert.deepEqual(await progress(), original);
  assert.deepEqual(
    await list.locator('[aria-current="true"]').allTextContents(),
    selected
  );
  assert.deepEqual(
    await Promise.all(editors.map((e) => e.inputValue())),
    drafts
  );
  assert.equal(
    await source.evaluate(
      (old, current) => old === current,
      await selectedReviewFile(frame)
        .locator(".current-columns,.saved-versions")
        .first()
        .elementHandle()
    ),
    true
  );
}
