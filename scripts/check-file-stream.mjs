import assert from "node:assert/strict";

// Same public scroll-only journey in browser and the actual VS Code webview.
export async function verifyFileStream(frame) {
  const panel = frame.locator("#current-changes"),
    slots = panel.locator("[data-review-file]");
  assert.ok(
    (await slots.count()) >= 2,
    "Fixture must have multiple paired files/steps"
  );
  const progress = () =>
    panel
      .locator('.changed-file input[type="checkbox"]')
      .evaluateAll((es) =>
        es.map((e) => [e.getAttribute("aria-label"), e.checked])
      );
  const before = await progress(),
    names = await panel.locator(".changed-file > button").allTextContents();
  const target = slots.last();
  const page = typeof frame.page === "function" ? frame.page() : frame;
  await panel.hover();
  await page.mouse.wheel(0, 1); // Begin a real reading gesture, retiring any entry reveal.
  // Continue scrolling while earlier long sources expand. A one-off DOM jump
  // to an estimated placeholder is not a complete reading gesture.
  const deadline = Date.now() + 25000;
  while (true) {
    await target.scrollIntoViewIfNeeded();
    const ready = target.locator(
      '.current-file-body[data-source-state="ready"]'
    );
    if (await ready.count()) break;
    assert.ok(
      Date.now() < deadline,
      "Scrolled source did not become available: " + (await target.innerText())
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    (await target.locator("code[data-source-line]").count()) > 0,
    "Actual source, not just a header or a DOM selection"
  );
  await target
    .locator("code[data-source-line]")
    .first()
    .scrollIntoViewIfNeeded();
  const line = await target
      .locator("code[data-source-line]")
      .first()
      .boundingBox(),
    viewport = await panel.boundingBox();
  assert.ok(
    line.y < viewport.y + viewport.height && line.y + line.height > viewport.y,
    "Read source inside the actual scrolling viewport"
  );
  assert.deepEqual(await progress(), before);
  assert.deepEqual(
    await panel.locator(".changed-file > button").allTextContents(),
    names
  );
  const original = panel.locator('[data-review-active="true"]');
  await original.scrollIntoViewIfNeeded();
  console.log(
    `PASS vertical file stream: scroll reaches another paired source with NO navigation click or Viewed credit.`
  );
}
