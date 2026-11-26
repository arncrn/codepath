import assert from "node:assert/strict";
import { callTool } from "../dist/client.mjs";

// Only the native suite's disposable project is supplied here.
export async function verifyNativeOverview(frame, root, returnTo) {
  const overview =
    "## Mental model\n\nA source call enters another function.\n\n## Worked example\n\n```ts\nsubmit();\n```\n";
  const walk = await callTool(root, "save_walkthrough", {
    title: "Native overview verification",
    overview,
    steps: [
      {
        id: "overview-call",
        title: "Call save",
        explanation: "Delegates persistence to save.",
        source: { file: "flow.ts", startLine: 2, endLine: 2 },
      },
    ],
  });
  // Narrow native editor columns intentionally hide the project sidebar. Use
  // the supported agent focus operation, then the visible Overview control.
  await callTool(root, "focus_step", {
    walkthroughId: walk.id,
    stepId: "overview-call",
  });
  await frame
    .locator('[data-step="overview-call"]')
    .waitFor({ state: "visible" });
  await frame.locator("#overview-page").click();
  const main = frame.locator("#walkthrough-overview");
  await main
    .getByRole("heading", { name: "Worked example", exact: true })
    .waitFor();
  assert.equal(await frame.locator("#walkthrough-cards").isVisible(), false);
  assert.equal(await main.locator("pre code").textContent(), "submit();");
  await main
    .getByRole("button", { name: "Edit overview", exact: true })
    .click();
  assert.equal(await frame.locator("#overview-text").inputValue(), overview);
  const changed =
    overview +
    "\n## Native edit\n\nSaved through the restricted VS Code host bridge.\n";
  await frame.locator("#overview-text").fill(changed);
  await main
    .getByRole("button", { name: "Save overview", exact: true })
    .click();
  await frame.locator("#overview-text").waitFor({ state: "hidden" });
  const saved = await callTool(root, "get_walkthrough", { id: walk.id });
  assert.equal(saved.overview, changed);
  assert.deepEqual(saved.steps, walk.steps);
  await main.locator('[data-overview-step="overview-call"]').click();
  await frame
    .locator('[data-step="overview-call"].active')
    .waitFor({ state: "visible" });
  await frame
    .locator("#note-text")
    .fill("Native note draft retained across the main page.");
  await frame.locator("#overview-page").click();
  await frame.locator("#cards-page").click();
  assert.equal(
    await frame.locator("#note-text").inputValue(),
    "Native note draft retained across the main page."
  );
  assert.equal(await frame.locator("#error").isVisible(), false);
  const original = await callTool(root, "get_walkthrough", { id: returnTo });
  await callTool(root, "focus_step", {
    walkthroughId: returnTo,
    stepId: original.steps[0].id,
  });
  await frame
    .locator(`[data-step="${original.steps[0].id}"].active`)
    .waitFor({ state: "visible" });
  console.log(
    "PASS native overview: Markdown examples, guarded host save, unchanged cards, exact raw editing, card links and note draft preservation."
  );
}
