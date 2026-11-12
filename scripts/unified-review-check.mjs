import assert from "node:assert/strict";

// Public DOM actions shared by browser and disposable native journeys.
export async function waitViewed(frame, label, checked) {
  await frame
    .getByRole("checkbox", { name: label, exact: true })
    .and(frame.locator(checked ? ":checked:enabled" : ":not(:checked):enabled"))
    .waitFor();
}
export async function chooseReviewFile(frame, group, file) {
  const panel = frame.locator("#current-changes");
  const target = panel.getByRole("button", {
    name: `Open ${group} ${file}`,
    exact: true,
  });
  if (!(await target.count())) {
    await panel
      .getByRole("button", { name: "Refresh changes", exact: true })
      .click();
  }
  await target.click();
  await target.and(panel.locator('[aria-current="true"]')).waitFor();
  await panel
    .locator(".current-diff-host .git-source-path")
    .filter({ hasText: file })
    .first()
    .waitFor();
  return panel;
}
export async function readSavedStep(frame, title) {
  const openSaved = frame.getByRole("button", {
    name: "Read saved guide source",
    exact: true,
  });
  if (
    !(await frame
      .getByRole("button", { name: "Back to current diff", exact: true })
      .count())
  ) {
    await openSaved.waitFor();
    await openSaved.click();
  }
  const panel = frame.locator("#git-comparisons");
  if (title)
    await panel
      .getByRole("navigation", { name: "Paired walkthrough steps" })
      .getByRole("button", { name: title, exact: true })
      .click();
  await panel.locator(".saved-versions").waitFor();
  return panel.locator(".saved-versions");
}
export async function assertParallel(frame, host, widths = [1550, 760]) {
  const page = typeof frame.page === "function" ? frame.page() : frame;
  for (const width of widths)
    for (const zoom of [1, 1.25, 2]) {
      await page.setViewportSize({ width, height: 1000 });
      await frame.locator("body").evaluate((element, value) => {
        element.style.zoom = String(value);
      }, zoom);
      const geometry = await host.evaluate((element) => {
        const boxes = [...element.querySelectorAll(".review-source")].map(
          (pane) => {
            const rect = pane.getBoundingClientRect();
            const line = pane
              .querySelector("code[data-source-line]")
              ?.getBoundingClientRect();
            return { x: rect.x, y: rect.y, first: line?.y };
          }
        );
        return boxes;
      });
      assert.equal(geometry.length, 2);
      assert.ok(
        geometry[1].x > geometry[0].x &&
          Math.abs(geometry[1].y - geometry[0].y) < 2,
        `${width}/${zoom}: parallel pane starts ${JSON.stringify(geometry)}`
      );
    }
  await frame.locator("body").evaluate((element) => {
    element.style.zoom = "1";
  });
  await page.setViewportSize({ width: 1550, height: 1000 });
}
