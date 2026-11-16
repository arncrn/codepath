import assert from "node:assert/strict";

// Actual Chrome AND native, both inline and detached. No synthetic CSS zoom.
export async function verifyFlowZoom(frame, reader = frame) {
  const out = frame.getByRole("button", { name: "Zoom out", exact: true });
  const plus = frame.getByRole("button", { name: "Zoom in", exact: true });
  const reset = frame.getByRole("button", {
    name: "Reset zoom to 100%",
    exact: true,
  });
  await out.waitFor({ timeout: 3000 });
  await out.scrollIntoViewIfNeeded();
  const svg = await frame.locator("#flow-panel svg").elementHandle();
  const outer = () =>
    reader.evaluate(() => ({
      page: [
        globalThis.document.querySelector("#workspace")?.scrollLeft ?? 0,
        globalThis.document.querySelector("#workspace")?.scrollTop ?? 0,
      ],
      rail: globalThis.document.querySelector("#rail")?.scrollLeft,
      selected: globalThis.document
        .querySelector(".code-card.active")
        ?.getAttribute("data-step"),
      panes: [...globalThis.document.querySelectorAll("#rail .code")].map(
        (e) => [e.scrollLeft, e.scrollTop]
      ),
    }));
  await frame.evaluate(() => {
    const e = globalThis.document.querySelector(".walkthrough-flow");
    e.scrollTop = (e.scrollHeight - e.clientHeight) / 2;
    e.scrollLeft = (e.scrollWidth - e.clientWidth) / 2;
  });
  const measure = () =>
    frame.evaluate(() => {
      const e = globalThis.document.querySelector(".walkthrough-flow"),
        s = e.querySelector("svg").getBoundingClientRect(),
        b = e.getBoundingClientRect();
      return {
        width: s.width,
        height: s.height,
        viewport: [b.x, b.y, b.width, b.height],
        point: [
          (b.left + e.clientLeft + e.clientWidth / 2 - s.left) / s.width,
          (b.top + e.clientTop + e.clientHeight / 2 - s.top) / s.height,
        ],
        canPan: [
          e.scrollWidth > e.clientWidth + 10,
          e.scrollHeight > e.clientHeight + 10,
        ],
      };
    });
  const original = await outer(),
    before = await measure();
  assert.equal(await reset.innerText(), "100%");
  await out.click();
  assert.equal(await reset.innerText(), "90%");
  const smaller = await measure();
  assert.ok(
    Math.abs(smaller.width / before.width - 0.9) < 0.01,
    "90% actually scales SVG geometry"
  );
  assert.deepEqual(
    smaller.viewport,
    before.viewport,
    "Zoom does not resize/move the diagram viewport"
  );
  for (const axis of [0, 1])
    if (before.canPan[axis] && smaller.canPan[axis])
      assert.ok(
        Math.abs(smaller.point[axis] - before.point[axis]) < 0.003,
        "Keep current viewport center anchored"
      );
  assert.deepEqual(
    await outer(),
    original,
    "No reading card/source/page/draft pane navigation"
  );
  await plus.click();
  assert.equal(await reset.innerText(), "100%");
  await out.click();
  await out.click();
  assert.equal(await reset.innerText(), "80%");
  await reset.click();
  assert.equal(await reset.innerText(), "100%");
  await frame.getByRole("button", { name: "Fit diagram", exact: true }).click();
  const fitted = await measure();
  assert.ok(fitted.width < before.width);
  await plus.click();
  assert.ok(
    (await measure()).width > fitted.width,
    "Zoom in starts from fitted scale, not abruptly from100%"
  );
  await reset.click();
  for (let i = 0; i < 10; i++) await out.click();
  assert.equal(await reset.innerText(), "1%");
  assert.equal(await out.isDisabled(), true);
  await reset.click();
  for (let i = 0; i < 30; i++) await plus.click();
  assert.equal(await reset.innerText(), "400%");
  assert.equal(await plus.isDisabled(), true);
  await reset.click();
  assert.equal(await reset.innerText(), "100%");
  assert.equal(
    await svg.evaluate(
      (a, b) => a === b,
      await frame.locator("#flow-panel svg").elementHandle()
    ),
    true,
    "Zoom never redraws/replaces Mermaid"
  );
  assert.deepEqual(await outer(), original);
}
