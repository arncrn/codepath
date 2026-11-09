import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { callTool } from "../dist/client.mjs";
import { startProjectService } from "../dist/service.mjs";
test("CLI/MCP transport refuses unsupported source queries and presentation writes to legacy or foreign services", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "codepath-legacy-client-")
  );
  fs.mkdirSync(path.join(root, ".codepaths"));
  let posts = 0,
    capability,
    sourceCapability,
    reportedRoot = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    assert.equal(req.headers["x-codepath-token"], "fixture");
    if (req.method === "GET") {
      res.end(
        JSON.stringify({
          root: reportedRoot,
          ...(capability === undefined
            ? {}
            : {
                capabilities: {
                  notePresentation: capability,
                  onDemandSource: sourceCapability,
                },
              }),
        })
      );
      return;
    }
    posts++;
    res.writeHead(400).end(JSON.stringify({ error: "Unexpected mutation" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(root, ".codepaths/connection.json"),
    JSON.stringify({ port: server.address().port, token: "fixture" })
  );
  for (capability of [undefined, false, "true"])
    for (const [name, fields] of [
      ["add_reviewed_note", { variableName: "value" }],
      ["review_note", { variableName: null }],
      ["review_note", { archived: false }],
      ["review_note", { archived: true }],
    ])
      await assert.rejects(
        callTool(root, name, fields),
        /Reload VS Code.*No note update was sent/
      );
  capability = true;
  for (sourceCapability of [undefined, false, "true"])
    for (const name of [
      "inspect_source",
      "list_source_files",
      "find_symbols",
      "read_source",
      "search_source",
      "follow_calls",
      "resolve_reference",
    ])
      await assert.rejects(
        callTool(root, name, { file: "flow.ts", query: "run" }),
        /No source request was sent/
      );
  sourceCapability = true;
  reportedRoot = "/different-project";
  await assert.rejects(
    callTool(root, "inspect_source", { file: "flow.ts" }),
    /No source request was sent/
  );
  await assert.rejects(
    callTool(root, "review_note", { archived: true }),
    /No note update was sent/
  );
  assert.equal(posts, 0);
});
test("CLI/MCP presentation and fieldless legacy calls use the actual updated service", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "codepath-current-client-")
  );
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function run(){ const value = 1; return value; }\n"
  );
  const service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let walk = await service.call("save_walkthrough", {
    title: "Client",
    steps: [
      {
        id: "run",
        title: "Run",
        source: { file: "flow.ts", symbol: "run" },
        explanation: "Purpose",
      },
    ],
  });
  const code = walk.steps[0].code,
    column = code.lines[0].indexOf("value");
  const common = {
    walkthroughId: walk.id,
    stepId: "run",
    sourceHash: code.hash,
    fileHash: code.fileHash,
    body: "Keeps the result that this function returns.",
    author: "Client",
    attachments: [
      {
        file: "flow.ts",
        fileHash: code.fileHash,
        startLine: 1,
        endLine: 1,
        startColumn: column,
        endColumn: column + 5,
        text: "value",
      },
    ],
  };
  const note = await callTool(root, "add_reviewed_note", {
    ...common,
    expectedRevision: walk.revision,
    variableName: "value",
  });
  assert.equal(note.variableName, "value");
  walk = await service.call("get_walkthrough", { id: walk.id });
  const preserved = await callTool(root, "review_note", {
    ...common,
    expectedRevision: walk.revision,
    noteId: note.id,
    body: "Fieldless old caller preserves explicit category.",
  });
  assert.equal(preserved.variableName, "value");
  walk = await service.call("get_walkthrough", { id: walk.id });
  const archived = await callTool(root, "review_note", {
    ...common,
    expectedRevision: walk.revision,
    noteId: note.id,
    archived: true,
  });
  assert.equal(archived.archived, true);
  assert.equal(archived.variableName, "value");
  assert.equal(archived.history.at(-1).body, preserved.body);
});
