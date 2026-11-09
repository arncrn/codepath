import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startProjectService } from "../dist/service.mjs";

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "codepath-no-role-control-")
);
fs.writeFileSync(
  path.join(root, "flow.ts"),
  "export function run() { return 1; }\n"
);
const roles = ["registration", "definition", "activation-call-site", undefined];
let service, browser;
try {
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  const walk = await service.call("save_walkthrough", {
    title: "Stored roles without a card control",
    steps: roles.map((callbackRole, index) => ({
      id: "step-" + index,
      title: "Step " + index,
      source: { file: "flow.ts", symbol: "run" },
      explanation: "Return a value.",
      ...(callbackRole ? { callbackRole } : {}),
    })),
  });
  const metadata = path.join(root, ".codepaths/workspace.json");
  const before = fs.readFileSync(metadata);
  browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(service.url);
  await page.locator(".code-card").first().waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: /^Callback role(?:…|\.\.\.)?$/ })
      .count(),
    0
  );
  for (let index = 0; index < roles.length; index++) {
    await page.locator(`[data-select="step-${index}"]`).click();
    assert.equal(await page.locator("#callback-role").count(), 0);
  }
  await page.reload();
  await page.locator(".code-card").first().waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: /^Callback role(?:…|\.\.\.)?$/ })
      .count(),
    0
  );
  assert.deepEqual(
    fs.readFileSync(metadata),
    before,
    "Reading/reloading must not remove stored roles."
  );
  assert.deepEqual(
    (await service.call("get_walkthrough", { id: walk.id })).steps.map(
      (step) => step.callbackRole
    ),
    roles
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS callback-role card control absent for labeled and unlabeled cards, including reload; stored labels and metadata unchanged. Backend role semantics remain covered by ordinary tests."
  );
} finally {
  await browser?.close();
  await service?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
