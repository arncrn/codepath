import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";

// Invoked inside the disposable native test, against the shipped agent and its
// real extension-owned service. No external LLM behavior is simulated/claimed.
export async function verifyNativeAuthoring(
  frame,
  root,
  extensionPath,
  testDir
) {
  const script = path.join(extensionPath, "dist/agent.mjs");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionPath, "package.json"), "utf8")
  );
  // The responsive UI intentionally hides the sidebar below 570px. Give this
  // disposable desktop window enough width for real navigation/config clicks.
  fs.writeFileSync(path.join(testDir, "authoring-maximize"), "ready");
  await frame.waitForFunction(() => globalThis.innerWidth >= 570);
  const original = await frame
    .locator("#paths button.selected")
    .getAttribute("data-path");
  async function call(name, args = {}, expectedExit = 0) {
    let stdout,
      stderr,
      code = 0;
    try {
      ({ stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          script,
          "--root",
          root,
          "--call",
          name,
          "--args",
          JSON.stringify(args),
        ],
        { timeout: 15000 }
      ));
    } catch (error) {
      if (!Number.isInteger(error.code)) throw error;
      ({ stdout, stderr, code } = error);
    }
    assert.equal(code, expectedExit, stderr);
    return JSON.parse(stdout);
  }
  const peer = spawn(process.execPath, [script, "--root", root], {
    timeout: 10000,
  });
  let output = "",
    errors = "";
  peer.stdout.setEncoding("utf8").on("data", (data) => {
    output += data;
  });
  peer.stderr.setEncoding("utf8").on("data", (data) => {
    errors += data;
  });
  peer.stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }) + "\n"
  );
  const [exit, signal] = await once(peer, "close");
  assert.equal(signal, null, errors);
  assert.equal(exit, 0, errors);
  const initialized = JSON.parse(output).result;
  assert.equal(initialized.serverInfo.version, manifest.version);
  assert.equal(
    await frame.locator(".prototype").textContent(),
    "Prototype " + manifest.version
  );

  await call("read_source", { file: "authoring.ts" });
  let walk = await call("save_walkthrough", {
    title: "Native source-linked authoring",
    steps: [
      {
        id: "calculate",
        title: "Calculate",
        source: { file: "authoring.ts", symbol: "calculate" },
        explanation:
          "Computes and returns the line total from a price and quantity.",
      },
    ],
  });
  assert.equal(
    (
      await call(
        "validate_walkthrough",
        { walkthroughId: walk.id, expectedRevision: walk.revision },
        1
      )
    ).ready,
    false
  );
  const source = walk.steps[0].code;
  async function note(fields) {
    const added = await call("add_reviewed_note", {
      walkthroughId: walk.id,
      stepId: "calculate",
      expectedRevision: walk.revision,
      sourceHash: source.hash,
      fileHash: source.fileHash,
      author: "Packaged native test",
      ...fields,
    });
    walk = await call("get_walkthrough", { id: walk.id });
    return added;
  }
  const blockBody = "Multiply the two inputs, then return the computed amount.";
  const block = await note({
    body: blockBody,
    attachments: [
      {
        file: source.file,
        fileHash: source.fileHash,
        startLine: 2,
        startColumn: 0,
        endLine: 3,
        endColumn: source.lines[2].length,
        text: source.lines.slice(1, 3).join("\n"),
      },
    ],
  });
  const variableBody = "The computed line total returned to this caller.";
  const variable = await note({
    body: variableBody,
    variableName: "amount",
    attachments: [2, 3].map((line) => {
      const start = source.lines[line - 1].indexOf("amount");
      return {
        file: source.file,
        fileHash: source.fileHash,
        startLine: line,
        startColumn: start,
        endLine: line,
        endColumn: start + 6,
        text: "amount",
      };
    }),
  });
  assert.equal(
    (
      await call("validate_walkthrough", {
        walkthroughId: walk.id,
        expectedRevision: walk.revision,
      })
    ).ready,
    true
  );

  await frame.locator(`#paths [data-path="${walk.id}"]`).click();
  await frame.locator('.code-card[data-step="calculate"]').waitFor();
  await frame.locator("#notes-tab").click();
  await frame.locator("#notes").getByText(blockBody, { exact: true }).waitFor();
  const marker = frame.locator(`[data-block-note-id="${block.id}"]`).first();
  assert.equal(
    await marker.evaluate(
      (el) => globalThis.getComputedStyle(el).backgroundColor
    ),
    await frame
      .locator(`#notes [data-explanation-id="${block.id}"]`)
      .evaluate((el) => globalThis.getComputedStyle(el).borderLeftColor)
  );
  for (const line of [2, 3]) {
    const target = frame.locator(
      `code[data-source-line="${line}"] .source-attachment`
    );
    // Native word tokens may wrap the same exact annotation range; assert
    // every decorated layer, without mistaking nesting for duplicated source.
    assert.ok(await target.count());
    for (const decorated of await target.all()) {
      assert.equal(await decorated.textContent(), "amount");
      assert.deepEqual(
        JSON.parse(await decorated.getAttribute("data-annotation-ids")),
        [variable.id]
      );
    }
    assert.equal(
      (
        await frame.locator(`code[data-source-line="${line}"]`).textContent()
      ).match(/amount/g).length,
      1
    );
  }
  await frame
    .locator('code[data-source-line="3"] .source-attachment')
    .first()
    .click();
  await frame
    .locator("#variables-panel")
    .getByText(variableBody, { exact: true })
    .waitFor();
  await frame.locator("#agent").click();
  const prompt = await frame.locator("#modal blockquote").innerText();
  assert.equal(
    prompt.replace(/\s+/g, " ").trim(),
    initialized.instructions.replace(/\s+/g, " ").trim()
  );
  await frame.locator("#close-modal").click();
  assert.equal(await frame.locator("#error").isVisible(), false);
  await frame.locator(`#paths [data-path="${original}"]`).click();
  console.log(
    "Packaged native authoring passed: shared MCP/UI policy, incomplete CLI exit 1, ready result, block colors and named Variable highlights."
  );
}
