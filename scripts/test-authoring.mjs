import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";
import { callTool } from "../dist/client.mjs";
import { walkthroughAuthoringInstructions } from "../dist/authoring-policy.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-authoring-browser-"));
fs.writeFileSync(
  path.join(root, "total.ts"),
  "export function total(price: number, quantity: number) {\n  const amount = price * quantity;\n  return amount;\n}\n"
);
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  const call = (name, args) => callTool(root, name, args);
  await call("read_source", { file: "total.ts" });
  let walk = await call("save_walkthrough", {
    title: "Calculate total",
    steps: [
      {
        id: "total",
        title: "Total",
        source: { file: "total.ts", symbol: "total" },
        explanation:
          "Multiplies the price by the quantity and returns the line total.",
      },
    ],
  });
  const check = () =>
    call("validate_walkthrough", {
      walkthroughId: walk.id,
      expectedRevision: walk.revision,
    });
  assert.equal((await check()).ready, false);
  const code = walk.steps[0].code;
  const write = async (fields) => {
    const note = await call("add_reviewed_note", {
      walkthroughId: walk.id,
      stepId: "total",
      expectedRevision: walk.revision,
      sourceHash: code.hash,
      fileHash: code.fileHash,
      author: "Deterministic authoring client",
      ...fields,
    });
    walk = await call("get_walkthrough", { id: walk.id });
    return note;
  };
  const blockBody = "Compute the line amount, then return it to the caller.";
  const block = await write({
    body: blockBody,
    attachments: [
      {
        file: code.file,
        fileHash: code.fileHash,
        startLine: 2,
        startColumn: 0,
        endLine: 3,
        endColumn: code.lines[2].length,
        text: code.lines.slice(1, 3).join("\n"),
      },
    ],
  });
  assert.ok(
    (await check()).issues.some((issue) => issue.code === "missing-variables")
  );
  const variableBody = "The computed line total returned by this call.";
  const variable = await write({
    body: variableBody,
    variableName: "amount",
    attachments: [2, 3].map((line) => {
      const start = code.lines[line - 1].indexOf("amount");
      return {
        file: code.file,
        fileHash: code.fileHash,
        startLine: line,
        startColumn: start,
        endLine: line,
        endColumn: start + 6,
        text: "amount",
      };
    }),
  });
  assert.equal((await check()).ready, true);
  const file = path.join(root, ".codepaths/workspace.json"),
    beforeReading = fs.readFileSync(file, "utf8");

  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator('.code-card[data-step="total"]').waitFor();
  await page.locator("#notes-tab").click();
  await page.locator("#notes").getByText(blockBody, { exact: true }).waitFor();
  const sourceBlock = page
    .locator(`[data-block-note-id="${block.id}"]`)
    .first();
  await sourceBlock.waitFor();
  const sourceColor = await sourceBlock.evaluate(
    (element) => globalThis.getComputedStyle(element).backgroundColor
  );
  const noteColor = await page
    .locator(`#notes [data-explanation-id="${block.id}"]`)
    .evaluate(
      (element) => globalThis.getComputedStyle(element).borderLeftColor
    );
  assert.equal(sourceColor, noteColor);
  assert.equal(
    await page
      .locator("#notes")
      .getByText(variableBody, { exact: true })
      .count(),
    0
  );
  for (const line of [2, 3]) {
    const target = page.locator(
      `code[data-source-line="${line}"] .source-attachment`
    );
    assert.equal(await target.textContent(), "amount");
    assert.deepEqual(
      JSON.parse(await target.getAttribute("data-annotation-ids")),
      [variable.id]
    );
  }
  await page.locator('code[data-source-line="3"] .source-attachment').click();
  await page
    .locator("#variables-panel")
    .getByText(variableBody, { exact: true })
    .waitFor();
  await page.locator("#agent").click();
  const prompt = await page.locator("#modal blockquote").innerText();
  assert.equal(
    prompt.replace(/\s+/g, " ").trim(),
    walkthroughAuthoringInstructions.replace(/\s+/g, " ").trim()
  );
  assert.equal(await page.locator("#error").isVisible(), false);
  assert.deepEqual(errors, []);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    beforeReading,
    "readiness checks and reading must not rewrite explanations"
  );
  console.log(
    "PASS authoring contract: real guarded client saves, incomplete/ready results, matching block colors, explicit Variable highlights/reveal, identical copied/MCP policy and no reader writes. Deterministic fixture, not an LLM behavior guarantee."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
