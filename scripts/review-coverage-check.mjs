import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { allChanges } from "../tests/fixtures/git-project.mjs";
import {
  chooseReviewFile,
  selectedReviewFile,
  readReviewStep,
} from "./unified-review-check.mjs";

// Same public UI/tool seam in Chrome and the disposable native host. All source
// and Git writes belong exclusively to the caller's owned fixture repository.
export async function verifyCoverage(frame, f, label) {
  const page = typeof frame.page === "function" ? frame.page() : frame;
  const cases = [
    {
      name: "bof",
      before: "alpha\nbeta\ngamma\ndelta\n",
      after: "insert\nalpha\nbeta\ngamma\ndelta\n",
      pairs: [
        [1, 2],
        [4, 5],
      ],
    },
    {
      name: "delete",
      before: "alpha\nbeta\ngamma\ndelta\n",
      after: "alpha\ngamma\ndelta\n",
      pairs: [
        [1, 1],
        [3, 2],
        [4, 3],
      ],
    },
    {
      name: "replace",
      before: "alpha\nbeta\ngamma\ndelta\n",
      after: "alpha\nnew one\nnew two\nnew three\ndelta\n",
      pairs: [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 5],
      ],
    },
    {
      name: "eof",
      before: "alpha\nbeta",
      after: "alpha\nbeta\nextra",
      pairs: [
        [1, 1],
        [2, 2],
      ],
    },
    {
      name: "crlf",
      before: "alpha\r\nbeta\r\n",
      after: "alpha\r\nnew\r\nbeta\r\n",
      pairs: [
        [1, 1],
        [2, 3],
      ],
    },
    {
      name: "bom",
      before: "\ufeffalpha\nbeta\n",
      after: "\ufeffalpha\nnew\nbeta\n",
      pairs: [
        [1, 1],
        [2, 3],
      ],
    },
    { name: "empty", before: "", after: "alpha\n", pairs: [] },
    {
      name: "normalized",
      before: "alpha\nbeta\n",
      after: "alpha\r\nnew\r\nbeta\r\n",
      pairs: [],
      plain: true,
    },
  ];
  cases.push({
    name: "blank-excerpt",
    extension: ".ts",
    before: "export function demo() {\n\n}\n",
    after: "export function demo() {\n  return 2;\n}\n",
    pairs: [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  });
  cases.push({
    name: "long-" + "path".repeat(35),
    extension: ".ts",
    before: "export function shortName() {\n  return 1;\n}\n",
    after: `export function ${"longName".repeat(25)}() {\n  const extra = 1;\n  return 1;\n}\n`,
    pairs: [
      [1, 1],
      [2, 3],
      [3, 4],
    ],
    longContext: "longName".repeat(25),
  });
  for (const c of cases) c.file = `coverage-${c.name}${c.extension ?? ".txt"}`;
  f.write(
    ".gitattributes",
    "coverage-crlf.txt -text\ncoverage-normalized.txt text eol=crlf\n"
  );
  for (const c of cases) f.write(c.file, c.before);
  f.write("coverage-deleted.txt", "removed source\n");
  f.write("coverage-renamed-before.txt", "exact renamed source\n");
  f.write("coverage-conflict.txt", "conflict base\n");
  f.git(
    "add",
    "--",
    ".gitattributes",
    ...cases.map((c) => c.file),
    "coverage-deleted.txt",
    "coverage-renamed-before.txt",
    "coverage-conflict.txt"
  );
  f.git("commit", "--quiet", "-m", "owned raw alignment fixtures");
  for (const c of cases) f.write(c.file, c.after);
  f.git("rm", "--", "coverage-deleted.txt");
  f.git("mv", "--", "coverage-renamed-before.txt", "coverage-renamed.txt");
  const head = String(f.git("rev-parse", "HEAD")).trim();
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${head},coverage-submodule`
  );
  if (label === "browser") {
    const oid = String(f.git("rev-parse", "HEAD:coverage-conflict.txt")).trim();
    f.gitInput(
      `0 ${"0".repeat(40)}\tcoverage-conflict.txt\n100644 ${oid} 1\tcoverage-conflict.txt\n100644 ${oid} 2\tcoverage-conflict.txt\n100644 ${oid} 3\tcoverage-conflict.txt\n`,
      "update-index",
      "--index-info"
    );
  }
  f.write("coverage-preview-large.txt", "x".repeat(140 * 1024));
  f.write("coverage-binary.bin", Buffer.from([0, 1, 255]));
  f.write(
    ".env.coverage-private",
    "never preview this owned private fixture\n"
  );
  f.write("coverage-invalid.bin", Buffer.from([255, 254]));
  f.write("coverage-huge.bin", "x".repeat(8 * 1024 * 1024 + 1));
  if (!(await frame.locator("#current-changes").isVisible()))
    await frame
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
  const panel = frame.locator("#current-changes");
  const selectedGuide = frame.locator("[data-comparison-path].selected");
  if (await selectedGuide.count()) await selectedGuide.click();
  await panel
    .locator(".current-source-choices")
    .getByRole("button", { name: "Changes", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  await panel.getByText(/restricted candidate paths not inspected/).waitFor();
  assert.equal(
    await panel
      .getByRole("button", { name: /Open .*env.coverage-private/ })
      .count(),
    0
  );
  assert.ok(
    (await panel.innerText()).includes("working change coverage unknown")
  );
  for (const c of cases) {
    // Reset layout zoom before the next pointer interaction. Native CDP's
    // cross-frame pointer conversion is not reliable under CSS zoom; geometry
    // itself is still sampled atomically at every required width/zoom below.
    await frame.locator("body").evaluate((el) => {
      el.style.zoom = "1";
    });
    await page.setViewportSize({ width: 1550, height: 1000 });
    await chooseReviewFile(frame, "unstaged", c.file);
    await panel
      .locator("[data-review-active=true] > .review-file-heading h2")
      .filter({ hasText: c.file })
      .waitFor();
    const left = panel.locator(
        '[data-review-active=true] [data-current-side="before"]'
      ),
      right = panel.locator(
        '[data-review-active=true] [data-current-side="after"]'
      );
    const count = (text) =>
      text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"));
    assert.equal(
      await left.locator("code[data-source-line]").count(),
      count(c.before),
      c.name + " before has no phantom numbered EOF"
    );
    assert.equal(
      await right.locator("code[data-source-line]").count(),
      count(c.after),
      c.name + " after has no phantom numbered EOF"
    );
    assert.equal(await panel.locator("[data-reference]").count(), 0);
    if (c.plain) {
      assert.equal(
        await panel
          .locator('[data-review-active="true"] :is(.diff-added,.diff-removed)')
          .count(),
        0
      );
      await panel
        .getByText(/Plain source — diff alignment unavailable/)
        .waitFor();
      continue;
    }
    for (const width of [1550, 760])
      for (const zoom of [1, 1.25, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await frame.locator("body").evaluate((el, zoom) => {
          el.style.zoom = String(zoom);
        }, zoom);
        const measured = await panel.evaluate((el, pairs) => {
          const rect = (selector) => {
            const r = el.querySelector(selector).getBoundingClientRect();
            return { x: r.x, y: r.y };
          };
          return {
            columns: [
              rect('[data-review-active=true] [data-current-side="before"]'),
              rect('[data-review-active=true] [data-current-side="after"]'),
            ],
            pairs: pairs.map(([a, b]) => [
              rect(
                `[data-review-active=true] [data-current-side="before"] code[data-source-line="${a}"]`
              ),
              rect(
                `[data-review-active=true] [data-current-side="after"] code[data-source-line="${b}"]`
              ),
            ]),
          };
        }, c.pairs);
        assert.ok(
          measured.columns[1].x > measured.columns[0].x,
          `${label}/${c.name}: never stack`
        );
        for (const [a, b] of measured.pairs)
          assert.ok(
            Math.abs(a.y - b.y) < 2,
            `${label}/${c.name}/${width}/${zoom}: ${JSON.stringify(measured)}`
          );
      }
    if (c.longContext)
      assert.equal(
        await right.locator(".function-context").textContent(),
        c.longContext
      );
    if (c.name === "bom")
      assert.equal(
        await left.locator('code[data-source-line="1"]').textContent(),
        "\ufeffalpha"
      );
    if (c.name === "eof")
      assert.equal(
        await right
          .getByText("No newline at end of file.", { exact: true })
          .count(),
        1
      );
  }
  await frame.locator("body").evaluate((el) => {
    el.style.zoom = "1";
  });
  await page.setViewportSize({ width: 1550, height: 1000 });
  await chooseReviewFile(frame, "staged", "coverage-renamed.txt");
  await panel
    .locator("[data-review-active=true] > .review-file-heading h2")
    .filter({ hasText: "coverage-renamed-before.txt → coverage-renamed.txt" })
    .waitFor();
  assert.equal(
    await panel
      .locator(
        '[data-review-active=true] [data-current-side="before"] code[data-source-line="1"]'
      )
      .textContent(),
    "exact renamed source"
  );
  assert.equal(
    await panel
      .locator(
        '[data-review-active=true] [data-current-side="after"] code[data-source-line="1"]'
      )
      .textContent(),
    "exact renamed source"
  );
  await chooseReviewFile(frame, "staged", "coverage-deleted.txt");
  await panel
    .locator("[data-review-active=true] > .review-file-heading h2")
    .filter({ hasText: "coverage-deleted.txt" })
    .waitFor();
  assert.equal(
    await panel
      .locator(
        '[data-review-active=true] [data-current-side="after"] code[data-source-line]'
      )
      .count(),
    0
  );
  await panel
    .locator('[data-review-active=true] [data-current-side="after"]')
    .getByText("No file on this side.", { exact: true })
    .waitFor();
  for (const [group, file, reason] of [
    ["staged", "coverage-submodule", /Unmerged entry or submodule/],
    ["untracked", "coverage-preview-large.txt", /128 KiB/],
    ["untracked", "coverage-binary.bin", /Binary content/],
    ...(label === "browser"
      ? [["staged", "coverage-conflict.txt", /Unmerged/]]
      : []),
  ]) {
    await chooseReviewFile(frame, group, file);
    await panel
      .locator("[data-review-active=true] > .review-file-heading h2")
      .filter({ hasText: file })
      .waitFor();
    await panel
      .locator('[data-review-active="true"]')
      .getByText(reason)
      .first()
      .waitFor();
  }
  const huge = panel.getByRole("checkbox", {
    name: "Viewed untracked coverage-huge.bin",
    exact: true,
  });
  assert.equal(await huge.isDisabled(), true);
  await chooseReviewFile(frame, "untracked", "coverage-invalid.bin");
  await panel
    .getByText("Invalid UTF-8: text diff unavailable.", { exact: true })
    .first()
    .waitFor();
  const invalid = panel.getByRole("checkbox", {
    name: "Viewed untracked coverage-invalid.bin",
    exact: true,
  });
  assert.equal(await invalid.isDisabled(), false);
  await invalid.click();
  await frame.waitForFunction(
    () =>
      globalThis.document.querySelector(
        'input[aria-label="Viewed untracked coverage-invalid.bin"]'
      )?.checked
  );
  await chooseReviewFile(frame, "unstaged", "coverage-replace.txt");
  await panel
    .locator("[data-review-active=true] > .review-file-heading h2")
    .filter({ hasText: "coverage-replace.txt" })
    .waitFor();
  const output = path.resolve(
    process.env.CODEPATH_TEST_OUTPUT_DIR || ".cache/review-coverage"
  );
  fs.mkdirSync(output, { recursive: true });
  await panel.screenshot({ path: path.join(output, `A-${label}-aligned.png`) });
  await page.setViewportSize({ width: 760, height: 1000 });
  await panel.screenshot({ path: path.join(output, `A-${label}-narrow.png`) });
  await page.setViewportSize({ width: 1550, height: 1000 });
  for (let i = 0; i < 111; i++)
    f.write(
      `coverage-ordinary-${String(i).padStart(3, "0")}.txt`,
      "diff only, no authoring needed\n"
    );
  if (label === "browser") {
    const failContinuation = async (route) => {
      const payload = route.request().postDataJSON();
      if (payload.name === "list_git_changes" && payload.arguments.cursor)
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Owned injected continuation failure.",
          }),
        });
      else await route.continue();
    };
    await page.route("**/api/call", failContinuation);
    const failed = page.waitForResponse(
      (response) =>
        response.status() === 400 &&
        response.request().postDataJSON()?.name === "list_git_changes"
    );
    await panel
      .getByRole("button", { name: "Refresh changes", exact: true })
      .click();
    await failed;
    await panel
      .getByRole("alert")
      .filter({ hasText: "Owned injected continuation failure" })
      .waitFor();
    await chooseReviewFile(frame, "unstaged", "coverage-bof.txt");
    await panel
      .locator("[data-review-active=true] > .review-file-heading h2")
      .filter({ hasText: "coverage-bof.txt" })
      .waitFor({ timeout: 5000 });
    assert.equal(
      await panel
        .locator(
          '[data-review-active=true] [data-current-side="after"] code[data-source-line="1"]'
        )
        .textContent(),
      "insert"
    );
    assert.equal(
      await panel
        .getByRole("checkbox", {
          name: "Viewed unstaged coverage-bof.txt",
          exact: true,
        })
        .isDisabled(),
      true
    );
    await page.unroute("**/api/call", failContinuation);
  }
  await panel
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await panel.locator('[data-inventory-ready="true"]').waitFor();
  await chooseReviewFile(frame, "untracked", "coverage-ordinary-110.txt");
  await panel
    .locator("[data-review-active=true] > .review-file-heading h2")
    .filter({ hasText: "coverage-ordinary-110.txt" })
    .waitFor();
  assert.equal(
    await panel
      .locator(
        '[data-review-active=true] [data-current-side="after"] code[data-source-line="1"]'
      )
      .textContent(),
    "diff only, no authoring needed"
  );
  assert.equal(await panel.locator(".review-note-tabs").count(), 0);
  const changes = await allChanges(f.service);
  const blankFile = changes.files.find(
    (file) => file.file === "coverage-blank-excerpt.ts"
  );
  assert.ok(blankFile);
  const blankSource = await f.service.call("get_git_file", {
    listId: changes.listId,
    fileId: blankFile.id,
  });
  const blankSide = (title) => ({
    title,
    purpose: "Shows this selected line.",
    startLine: 2,
    endLine: 2,
    notes: [],
    variables: [],
    notApplicable: {
      notes: "No extra block description needed.",
      variables: "No named variable on this line.",
    },
  });
  const blankGuide = await f.service.call("create_comparison_walkthrough", {
    title: "Blank selected line geometry",
    listId: changes.listId,
    steps: [
      {
        id: "blank",
        title: "Selected blank replacement",
        fileId: blankFile.id,
        binding: blankSource.binding,
        before: blankSide("Before line"),
        after: blankSide("After line"),
      },
    ],
  });
  await frame.locator(`[data-comparison-path="${blankGuide.id}"]`).click();
  const authored = frame.locator("#current-changes");
  await chooseReviewFile(frame, "unstaged", "coverage-blank-excerpt.ts");
  await frame.locator(`[data-comparison-path="${blankGuide.id}"]`).click();
  await authored
    .locator(
      '[data-review-active=true] [data-current-side="after"] code[data-source-line="2"]'
    )
    .waitFor();
  assert.equal(
    await authored
      .locator(
        '[data-review-active=true] [data-current-side="before"] code[data-source-line="2"]'
      )
      .textContent(),
    ""
  );
  assert.equal(
    await authored
      .locator(
        '[data-review-active=true] [data-current-side="after"] code[data-source-line="2"]'
      )
      .textContent(),
    "  return 2;"
  );
  for (const width of [1550, 760])
    for (const zoom of [1, 1.25, 2]) {
      await page.setViewportSize({ width, height: 1000 });
      await frame.locator("body").evaluate((element, value) => {
        element.style.zoom = String(value);
      }, zoom);
      const geometry = await authored.evaluate((element) => {
        const y = (side) =>
          element
            .querySelector(
              `[data-review-active=true] [data-current-side="${side}"] code[data-source-line="2"]`
            )
            .getBoundingClientRect().y;
        return { before: y("before"), after: y("after") };
      });
      assert.ok(
        Math.abs(geometry.before - geometry.after) < 2,
        `${label} blank selected source must keep genuine row alignment: ${JSON.stringify({ width, zoom, geometry })}`
      );
    }
  await frame.locator("body").evaluate((element) => {
    element.style.zoom = "1";
  });
  await page.setViewportSize({ width: 1550, height: 1000 });
  await frame.locator(`[data-comparison-path="${blankGuide.id}"]`).click();
  const inlineBlank = await readReviewStep(frame, "Selected blank replacement");
  assert.equal(
    await frame
      .getByRole("button", { name: "Read saved guide source", exact: true })
      .count(),
    0
  );
  for (const width of [1550, 760])
    for (const zoom of [1, 1.25, 2]) {
      await page.setViewportSize({ width, height: 1000 });
      await frame.locator("body").evaluate((element, value) => {
        element.style.zoom = String(value);
      }, zoom);
      const geometry = await inlineBlank.evaluate((element) => {
        const row = (side) =>
          element
            .querySelector(
              `[data-current-side="${side}"] code[data-source-line="2"]`
            )
            .getBoundingClientRect();
        return { before: row("before").y, after: row("after").y };
      });
      assert.ok(
        Math.abs(geometry.before - geometry.after) < 2,
        `${label} explicit saved blank excerpt alignment ${width}/${zoom}: ${JSON.stringify(geometry)}`
      );
      assert.equal(
        await inlineBlank.locator("pre").count(),
        2,
        "No duplicate saved source for a blank explanation range"
      );
    }
  await frame.locator("body").evaluate((element) => {
    element.style.zoom = "1";
  });
  await page.setViewportSize({ width: 1550, height: 1000 });
  await frame.locator(`[data-comparison-path="${blankGuide.id}"]`).click();
  console.log(
    `PASS ${label} inline blank-range explanations retain genuine full-source row alignment at 1550/760 ×100/125/200%, no alternate source mode.`
  );
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  console.log(
    `PASS ${label} A raw alignment: insertion/deletion/replacement/BOF/EOF/empty/CRLF/BOM, no ghost lines, honest normalized fallback, restricted visibility, exact invalidUTF8/manual mark and huge mark refusal; same-frame 1550/760 at 100/125/200%.`
  );
}

// Public clicks and project tools, shared by Chrome and the native webview.
export async function verifyGuideToggle(frame, f, label) {
  const fileName = "guide-toggle-source.ts",
    plainFile = "guide-toggle-plain.ts";
  f.write(fileName, "export const padding = null;\n");
  f.write(plainFile, "// No authored excerpt\nexport const plain = true;\n");
  const list = await allChanges(f.service);
  const file = list.files.find((file) => file.file === fileName);
  assert.ok(file);
  const source = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const side = (title, startLine) => ({
    title,
    purpose: "Provides this navigation test's source target.",
    startLine,
    endLine: startLine,
    notes: [],
    variables: [],
    notApplicable: {
      notes: "No block explanation needed for this navigation fixture.",
      variables: "No variable explanation needed for this navigation fixture.",
    },
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Toggle back to files",
    listId: list.listId,
    steps: [
      {
        id: "toggle",
        title: "Navigation target",
        fileId: file.id,
        binding: source.binding,
        before: side("Absent before", 0),
        after: side("Source after", 1),
      },
    ],
  });
  const stored = await f.service.call("get_comparison_walkthrough", {
    id: saved.id,
  });
  const current = frame.locator("#current-changes");
  if (!(await current.isVisible()))
    await frame
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
  await current
    .getByRole("button", { name: "Refresh changes", exact: true })
    .click();
  await current.locator('[data-inventory-ready="true"]').waitFor();
  await chooseReviewFile(frame, "untracked", fileName);
  await current.getByRole("heading", { name: fileName, exact: true }).waitFor();
  const viewed = current.getByRole("checkbox", {
    name: "Viewed untracked " + fileName,
    exact: true,
  });
  assert.equal(await viewed.isChecked(), false);
  await viewed.click();
  await frame.waitForFunction(
    () =>
      globalThis.document.querySelector(
        'input[aria-label="Viewed untracked guide-toggle-source.ts"]'
      )?.checked
  );
  const guide = frame.locator(`[data-comparison-path="${saved.id}"]`);
  await guide.click();
  const authored = frame.locator("#git-comparisons");
  await authored
    .getByRole("heading", { name: saved.title, exact: true })
    .waitFor();
  await guide.click();
  await current
    .getByRole("heading", { name: "Current changes", exact: true })
    .waitFor({ timeout: 2000 });
  await current.getByRole("heading", { name: fileName, exact: true }).waitFor();
  await frame.waitForFunction(
    () =>
      globalThis.document.querySelector(
        'input[aria-label="Viewed untracked guide-toggle-source.ts"]'
      )?.checked
  );
  assert.equal(await authored.isVisible(), true);
  assert.equal(
    await selectedReviewFile(frame)
      .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
      .count(),
    2,
    "Full mode retains admitted Notes"
  );
  assert.equal(await selectedReviewFile(frame).locator("pre").count(), 2);
  assert.equal(
    (await guide.getAttribute("class"))?.includes("selected"),
    false
  );
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    stored
  );
  const other = await f.service.call("create_comparison_walkthrough", {
    title: "Another saved guide",
    listId: list.listId,
    steps: [
      {
        id: "other",
        title: "Other navigation target",
        fileId: file.id,
        binding: source.binding,
        before: side("Other absence", 0),
        after: side("Other source", 1),
      },
    ],
  });
  const otherStored = await f.service.call("get_comparison_walkthrough", {
    id: other.id,
  });
  const otherGuide = frame.locator(`[data-comparison-path="${other.id}"]`);
  const after = selectedReviewFile(frame).locator('[data-git-side="after"]');
  await guide.click();
  await authored
    .getByRole("heading", { name: saved.title, exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  await after
    .getByLabel("Note text", { exact: true })
    .fill("Unsaved first-guide draft");
  await chooseReviewFile(frame, "untracked", plainFile);
  await current
    .locator("[data-review-active=true] > .review-file-heading h2")
    .filter({ hasText: plainFile })
    .waitFor();
  assert.ok(
    (await guide.getAttribute("class")).includes("selected"),
    "File navigation keeps guide enabled in native/browser"
  );
  assert.equal(
    await selectedReviewFile(frame).locator(".guide-display").count(),
    0
  );
  await chooseReviewFile(frame, "untracked", fileName);
  await after
    .getByRole("heading", { name: "Source after", exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text").inputValue(),
    "Unsaved first-guide draft"
  );
  await otherGuide.click();
  await authored
    .getByRole("heading", { name: other.title, exact: true })
    .waitFor();
  assert.equal(
    await current.isVisible(),
    true,
    "A different guide retains the complete current review"
  );
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text", { exact: true }).inputValue(),
    ""
  );
  await after
    .getByLabel("Note text", { exact: true })
    .fill("Unsaved second-guide draft");
  await guide.click();
  await authored
    .getByRole("heading", { name: saved.title, exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text", { exact: true }).inputValue(),
    "Unsaved first-guide draft"
  );
  await guide.click();
  await current
    .getByRole("heading", { name: "Current changes", exact: true })
    .waitFor();
  await current
    .getByRole("heading", { name: fileName, exact: true })
    .waitFor({ timeout: 5000 });
  assert.equal(
    await current
      .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
      .count(),
    2
  );
  await frame.waitForFunction(
    () =>
      globalThis.document.querySelector(
        'input[aria-label="Viewed untracked guide-toggle-source.ts"]'
      )?.checked
  );
  await otherGuide.click();
  await authored
    .getByRole("heading", { name: other.title, exact: true })
    .waitFor();
  await after.getByRole("button", { name: "Write note", exact: true }).click();
  assert.equal(
    await after.getByLabel("Note text", { exact: true }).inputValue(),
    "Unsaved second-guide draft",
    "Closing and reopening a guide must retain its independent unsaved draft"
  );
  await otherGuide.click();
  await current.getByRole("heading", { name: fileName, exact: true }).waitFor();
  assert.equal(
    await current
      .getByRole("button", { name: /^Notes(?: · \d+)?$/, exact: true })
      .count(),
    2
  );
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    stored
  );
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: other.id }),
    otherStored
  );
  await viewed.click();
  await frame.waitForFunction(
    () =>
      !globalThis.document.querySelector(
        'input[aria-label="Viewed untracked guide-toggle-source.ts"]'
      )?.checked
  );
  await frame
    .getByRole("button", { name: "Back to walkthrough", exact: true })
    .click();
  console.log(
    `PASS ${label} selected-guide toggle returns to the selected file, preserves Viewed progress and independent unsaved note drafts; different guides open normally and saved records stay unchanged.`
  );
}
