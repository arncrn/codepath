import assert from "node:assert/strict";

// Public DOM actions shared by browser and disposable native journeys.
export function selectedReviewFile(frame) {
  return frame.locator(
    '#current-changes [data-review-active="true"], #current-changes [data-unmatched-active="true"]'
  );
}
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
  await selectedReviewFile(frame)
    .locator(".git-source-path")
    .filter({ hasText: file })
    .first()
    .waitFor();
  return panel;
}
export async function readReviewStep(frame, title) {
  const panel = frame.locator("#current-changes");
  let source;
  if (title) {
    const heading = panel
      .locator("[data-review-step-title]")
      .filter({
        hasText: new RegExp(
          "^" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"
        ),
      })
      .first();
    const article = heading.locator("xpath=ancestor::article[1]");
    await article
      .getByRole("button", { name: /^Notes and Variables for / })
      .first()
      .click();
    const picker = article.getByRole("combobox", {
      name: "Comparison explanation to edit",
      exact: true,
    });
    if (await picker.count()) await picker.selectOption({ label: title });
    source = article;
  } else source = selectedReviewFile(frame);
  await source.waitFor();
  if (await source.getAttribute("data-review-file"))
    await source
      .locator('.current-file-body[data-source-state="ready"]')
      .waitFor();
  await source.locator("[data-inline-explanation]").first().waitFor();
  return source.locator(".current-columns,.unmatched-explanation-columns");
}
export async function readVariable(scope, text) {
  const body = scope.getByText(text, { exact: true });
  const owner = body.locator(
    "xpath=ancestor::*[@data-inline-explanation or @data-walkthrough-card][1]"
  );
  await owner
    .getByRole("button", { name: /^Variables(?: · \d+)?$/, exact: true })
    .click();
  await body.waitFor();
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
