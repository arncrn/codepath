import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { startProjectService } from "../dist/service.mjs";

test("Named UI operations exercise the real authenticated workspace interface", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-ui-api-"));
  const service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function run() { return 1; }\n"
  );
  const originalFetch = globalThis.fetch;
  const originalConfig = globalThis.CODEPATH_CONFIG;
  const originalToken = globalThis.CODEPATH_TOKEN;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalConfig === undefined) delete globalThis.CODEPATH_CONFIG;
    else globalThis.CODEPATH_CONFIG = originalConfig;
    if (originalToken === undefined) delete globalThis.CODEPATH_TOKEN;
    else globalThis.CODEPATH_TOKEN = originalToken;
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  globalThis.CODEPATH_CONFIG = {
    root: service.root,
    demo: false,
    backend: "node",
    toolRoot: process.cwd(),
  };
  globalThis.CODEPATH_TOKEN = JSON.parse(
    fs.readFileSync(path.join(root, ".codepaths/connection.json"), "utf8")
  ).token;
  // Supply the browser's origin resolution in Node; the service and its
  // authentication, validation, persistence and errors are real, not mocked.
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
  assert.equal((await api.getProjectOverview()).root, service.root);
  const browserFetch = globalThis.fetch;
  let unsupportedPosts = 0,
    sourceFault = "capability";
  globalThis.fetch = async (url, options) => {
    if (options?.method === "POST") unsupportedPosts++;
    const response = await browserFetch(url, options);
    const value = await response.json();
    if (String(url) === "/api/state") {
      if (sourceFault === "capability")
        delete value.capabilities.onDemandSource;
      else value.root = "/different-project";
    }
    return new Response(JSON.stringify(value), { status: response.status });
  };
  await assert.rejects(
    api.inspectSource("flow.ts"),
    /Reload VS Code.*Your draft is kept/
  );
  sourceFault = "root";
  await assert.rejects(
    api.inspectSource("flow.ts"),
    /Reload VS Code.*Your draft is kept/
  );
  assert.equal(unsupportedPosts, 0);
  globalThis.fetch = browserFetch;
  assert.match((await api.readSource("flow.ts")).text, /return 1/);
  assert.equal((await api.inspectSource("flow.ts")).symbols[0].name, "run");
  assert.deepEqual((await api.listSourceFiles("flow")).files, [
    { file: "flow.ts" },
  ]);
  assert.equal((await api.findSourceSymbols("run")).symbols[0].name, "run");
  assert.equal((await api.searchSource("return 1")).hits.length, 1);
  const walk = await api.saveWalkthrough({
    title: "Read run",
    steps: [
      { id: "run", title: "Run", source: { file: "flow.ts", symbol: "run" } },
    ],
  });
  assert.equal(
    (await api.getWalkthrough(walk.id)).steps[0].code.file,
    "flow.ts"
  );
  await api.addNote({
    walkthroughId: walk.id,
    stepId: "run",
    body: "The function returns 1.",
    author: "Interface test",
  });
  const run = await api.recordRun({
    walkthroughId: walk.id,
    label: "Example",
    mode: "example",
    origin: "Invented test fixture, not execution.",
    events: [{ stepId: "run", output: 1 }],
  });
  assert.equal((await api.listRuns(walk.id)).length, 1);
  assert.equal((await api.getRun(run.id)).mode, "example");
  let current = await api.getWalkthrough(walk.id);
  assert.equal(current.steps[0].notes[0].body, "The function returns 1.");
  const code = current.steps[0].code;
  current = await api.saveWalkthroughFlow({
    walkthroughId: walk.id,
    expectedRevision: current.revision,
    graph: {
      version: 1,
      summary:
        "The source is truly linear: one constant return, not a card-order edge.",
      nodes: [
        {
          id: "return",
          stepId: "run",
          kind: "exit",
          label: "Return 1",
          sourceHash: code.hash,
          attachment: {
            file: code.file,
            fileHash: code.fileHash,
            startLine: 1,
            endLine: 1,
            startColumn: 24,
            endColumn: 33,
            text: "return 1;",
          },
        },
      ],
      edges: [],
    },
  });
  assert.equal(current.flowState.status, "current");
  await assert.rejects(
    api.saveWalkthroughFlow({
      walkthroughId: walk.id,
      expectedRevision: current.revision - 1,
      graph: null,
    }),
    /changed/
  );
  current = await api.saveWalkthroughFlow({
    walkthroughId: walk.id,
    expectedRevision: current.revision,
    graph: null,
  });
  assert.equal(current.flowState.status, "absent");
  await api.deleteWalkthrough({
    id: walk.id,
    expectedRevision: current.revision,
  });
  await assert.rejects(api.getWalkthrough(walk.id), /not found/);
  await assert.rejects(
    api.openSourceInEditor({ walkthroughId: walk.id, stepId: "run" }),
    /requires VS Code/
  );
  await assert.rejects(
    api.followDefinition({
      walkthroughId: walk.id,
      stepId: "run",
      fileHash: "unused",
      line: 1,
      column: 0,
    }),
    /requires VS Code/
  );
});
