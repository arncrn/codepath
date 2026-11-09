import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { startProjectService } from "../dist/service.mjs";
import { dispatchWebviewRequest } from "../dist/vscode/bridge.mjs";
import { tools } from "../dist/tools.mjs";

test("named annotation operations cross authenticated HTTP and the restricted webview bridge", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "codepath-annotation-interface-")
  );
  fs.writeFileSync(path.join(root, "flow.ts"), "export const value = 1;\n");
  const service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    delete globalThis.CODEPATH_CONFIG;
    delete globalThis.CODEPATH_TOKEN;
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  globalThis.CODEPATH_CONFIG = {
    root: service.root,
    backend: "node",
    demo: false,
    toolRoot: process.cwd(),
  };
  globalThis.CODEPATH_TOKEN = JSON.parse(
    fs.readFileSync(path.join(root, ".codepaths/connection.json"), "utf8")
  ).token;
  globalThis.fetch = (url, options) =>
    originalFetch(new URL(url, service.url), options);
  const compiled = await build({
    entryPoints: ["ui/api.ts"],
    bundle: true,
    write: false,
    format: "esm",
    define: { window: "globalThis" },
  });
  const api = await import(
    "data:text/javascript;base64," +
      Buffer.from(compiled.outputFiles[0].text).toString("base64")
  );
  let walk = await api.saveWalkthrough({
    title: "Interface fixture",
    steps: [
      {
        id: "value",
        title: "Value",
        source: { file: "flow.ts", startLine: 1, endLine: 1 },
        explanation: "Original",
      },
    ],
  });
  async function review() {
    walk = await api.getWalkthrough(walk.id);
    return {
      walkthroughId: walk.id,
      stepId: "value",
      expectedRevision: walk.revision,
      sourceHash: walk.steps[0].code.hash,
      fileHash: walk.steps[0].code.fileHash,
      body: "Reviewed value",
      author: "Interface reviewer",
      attachments: [],
    };
  }
  const note = await api.addReviewedNote(await review());
  const updated = await api.reviewNote({
    ...(await review()),
    noteId: note.id,
    body: "Corrected",
  });
  assert.equal(updated.id, note.id);
  assert.equal(updated.history[0].body, "Reviewed value");
  walk = await api.reviewExplanation(await review());
  assert.equal(walk.steps[0].explanationHistory[0].body, "Original");
  walk = await api.repairStepSource({
    walkthroughId: walk.id,
    stepId: "value",
    expectedRevision: walk.revision,
    source: walk.steps[0].source,
    fileHash: walk.steps[0].code.fileHash,
  });
  assert.ok(
    walk.steps[0].notes[0].stale,
    "even equal-content source repair cannot imply content review"
  );
  const args = { ...(await review()), noteId: note.id };
  const result = await dispatchWebviewRequest(service, "/api/call", {
    name: "review_note",
    arguments: args,
  });
  assert.equal(result.id, note.id);
  await assert.rejects(
    dispatchWebviewRequest(service, "/api/call", {
      name: "review_note",
      arguments: args,
    }),
    /changed/
  );
  await assert.rejects(
    dispatchWebviewRequest(service, "/api/call", {
      name: "add_reviewed_note",
      arguments: { ...(await review()), attachments: "invalid" },
    }),
    /attachments/
  );
  for (const name of [
    "review_note",
    "review_explanation",
    "add_reviewed_note",
    "repair_step_source",
  ]) {
    const tool = tools.find((tool) => tool.name === name);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.ok(tool.inputSchema.required.includes("expectedRevision"));
    assert.ok(tool.inputSchema.required.includes("fileHash"));
  }
});
