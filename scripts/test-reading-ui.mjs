import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepath-reading-ui-"));
const output = path.resolve(
  process.env.CODEPATH_TEST_OUTPUT_DIR ?? ".cache/reading-ui"
);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(root, "flow.ts"),
  "export function run(value: number) {\n  return value + 1;\n}\n"
);
fs.writeFileSync(
  path.join(root, "other.ts"),
  "export function other() { return 2; }\n"
);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  let walk = await service.call("save_walkthrough", {
    title: "Reading",
    description:
      "Read at three levels: the card summary explains the function’s purpose (high level); Notes explain code blocks/function calls (medium) and individual variable roles (low). This is an architecture reading order, not an execution trace. Continue with 01 → 02 → 03 → 05 → 04 → 06 for concrete behaviors.",
    steps: [
      {
        id: "run",
        title: "Run",
        source: { file: "flow.ts", symbol: "run" },
        explanation: "Adds one to the supplied value.",
      },
      {
        id: "other",
        title: "Other",
        source: { file: "other.ts", symbol: "other" },
        explanation: "Another step.",
      },
    ],
  });
  const review = async () => {
    walk = await service.call("get_walkthrough", { id: walk.id });
    const code = walk.steps[0].code;
    return {
      walkthroughId: walk.id,
      stepId: "run",
      expectedRevision: walk.revision,
      sourceHash: code.hash,
      fileHash: code.fileHash,
      author: "Fixture",
      attachments: [],
    };
  };
  const note = await service.call("add_reviewed_note", {
    ...(await review()),
    body: "Initial block explanation.",
  });
  await service.call("review_note", {
    ...(await review()),
    noteId: note.id,
    body: "The return statement adds one.",
  });
  await service.call("review_explanation", {
    ...(await review()),
    body: "Adds one to the supplied value.",
  });
  await service.call("add_reviewed_note", {
    ...(await review()),
    body: "Old glossary retained internally.",
    archived: true,
  });
  fs.unlinkSync(path.join(root, "other.ts"));
  const metadataFile = path.join(root, ".codepaths/workspace.json");
  const before = fs.readFileSync(metadataFile, "utf8");
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    reverseQueries = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.postDataJSON()?.name === "source_usages"
    )
      reverseQueries.push(request.url());
  });
  await page.goto(service.url);
  await page.locator('.code-card[data-step="run"]').waitFor();
  await page.locator("#notes-tab").click();
  await page
    .getByRole("button", { name: "Write attached note", exact: true })
    .click();
  const forbidden = [
    ["architecture introduction", "#description"],
    ["ONE BEHAVIOR label", ".eyebrow"],
    ["Source usages / unresolved saved references", ".source-usages"],
    ["card explanation review/history", ".card-review"],
    ["edit/history disclosure", ".note-details"],
    ["archived lists", ".archived-notes"],
    ["source/revision guard disclosure", ".review-guards"],
  ];
  const present = [];
  for (const [label, selector] of forbidden)
    if (await page.locator(selector).count()) present.push(label);
  for (const phrase of [
    "Prior card explanations",
    "Prior versions",
    "Source and metadata revision guards",
    "Saved references only. Repetition does not establish recursion or execution order.",
    "Old glossary retained internally.",
  ])
    if (await page.getByText(phrase, { exact: false }).count())
      present.push(phrase);
  if (
    await page
      .getByRole("button", { name: /^Callback role(?:…|\.\.\.)?$/ })
      .count()
  )
    present.push("Callback role card control");
  if (reverseQueries.length) present.push("background source_usages requests");
  assert.deepEqual(
    present,
    [],
    "Unrequested UI must be absent, not merely collapsed."
  );
  assert.equal(
    fs.readFileSync(metadataFile, "utf8"),
    before,
    "Removing UI must not delete saved data/history."
  );
  await page.screenshot({ path: path.join(output, "reading.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS minimal reading UI: no requested clutter, no reverse-reference polling, saved data/history unchanged."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
