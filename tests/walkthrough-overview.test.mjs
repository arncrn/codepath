import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../dist/workspace.mjs";
import { startProjectService } from "../dist/service.mjs";
import { callTool } from "../dist/client.mjs";
import { dispatchWebviewRequest } from "../dist/vscode/bridge.mjs";

const body =
  "## Big picture\n\nOne request calls a callback.\n\n## Mental model\n\n- Registration is not execution.\n\n## Example\n\n```go\nserver.Handle()\n```\n";
function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cp-overview-"))
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "main.go"),
    "package main\nfunc Run() {\n  println(1)\n}\n"
  );
  return { root, workspace: openWorkspace(root) };
}
function create(workspace, extra = {}) {
  return workspace.invoke("save_walkthrough", {
    title: "Run the example",
    description: "A short sidebar description, separate from the cheat sheet.",
    steps: [
      {
        id: "run",
        title: "Print",
        explanation: "Prints the configured value.",
        source: { file: "main.go", startLine: 3, endLine: 3 },
      },
    ],
    ...extra,
  });
}

test("An optional Markdown overview preserves exact text, survives reopen and is excluded from lightweight summaries", (t) => {
  const { root, workspace } = fixture(t);
  const legacy = create(workspace);
  assert.equal(Object.hasOwn(legacy, "overview"), false);
  const walk = create(workspace, { overview: body });
  assert.equal(walk.overview, body);
  assert.equal(
    openWorkspace(root).invoke("get_walkthrough", { id: walk.id }).overview,
    body
  );
  assert.equal(
    Object.hasOwn(
      workspace.overview().paths.find((p) => p.id === walk.id),
      "overview"
    ),
    false
  );
  const edited = workspace.invoke("save_walkthrough", {
    id: walk.id,
    title: "Renamed",
    description: walk.description,
    steps: walk.steps,
    expectedRevision: walk.revision,
  });
  assert.equal(
    edited.overview,
    body,
    "Old card-editing clients must not erase an omitted overview"
  );
});

test("Overview-only saves are revision guarded and preserve stale source, card/note IDs, hashes, history and runs", (t) => {
  const { root, workspace } = fixture(t);
  const walk = create(workspace, { overview: body });
  const note = workspace.invoke("add_note", {
    walkthroughId: walk.id,
    stepId: "run",
    author: "Reader",
    body: "Keep this note",
  });
  workspace.invoke("record_run", {
    walkthroughId: walk.id,
    label: "Retained example",
    mode: "example",
    origin: "Overview regression fixture",
    events: [{ stepId: "run", output: { value: 1 } }],
  });
  const runs = workspace.invoke("list_runs", { walkthroughId: walk.id });
  fs.unlinkSync(path.join(root, "main.go"));
  const current = workspace.invoke("get_walkthrough", { id: walk.id });
  const saved = workspace.invoke("save_walkthrough_overview", {
    walkthroughId: walk.id,
    expectedRevision: current.revision,
    overview: body + "\nOne extra detail.\n",
  });
  assert.equal(saved.revision, current.revision + 1);
  assert.deepEqual(saved.steps, current.steps);
  assert.equal(saved.steps[0].notes[0].id, note.id);
  assert.equal(saved.steps[0].stale, true);
  assert.deepEqual(
    workspace.invoke("list_runs", { walkthroughId: walk.id }),
    runs
  );
  const disk = fs.readFileSync(
    path.join(root, ".codepaths/workspace.json"),
    "utf8"
  );
  assert.throws(
    () =>
      workspace.invoke("save_walkthrough_overview", {
        walkthroughId: walk.id,
        expectedRevision: current.revision,
        overview: "Stale edit",
      }),
    /changed/i
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
    disk
  );
  const cleared = workspace.invoke("save_walkthrough_overview", {
    walkthroughId: walk.id,
    expectedRevision: saved.revision,
    overview: "",
  });
  assert.equal(cleared.overview, "");
});

test("Invalid and over-limit overviews reject without partial writes; malformed saved fields are refused on reopen", (t) => {
  const { root, workspace } = fixture(t);
  const walk = create(workspace, { overview: body });
  const file = path.join(root, ".codepaths/workspace.json");
  const before = fs.readFileSync(file, "utf8");
  for (const overview of [null, 5, {}, "x".repeat(30001)]) {
    assert.throws(() => create(workspace, { overview }), /overview/i);
    assert.throws(
      () =>
        workspace.invoke("save_walkthrough_overview", {
          walkthroughId: walk.id,
          expectedRevision: walk.revision,
          overview,
        }),
      /overview/i
    );
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  const boundary = workspace.invoke("save_walkthrough_overview", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    overview: "x".repeat(30000),
  });
  assert.equal(boundary.overview.length, 30000);
  const invalid = JSON.parse(before);
  invalid.paths[0].overview = { invalid: true };
  fs.writeFileSync(file, JSON.stringify(invalid));
  assert.throws(() => openWorkspace(root), /overview/i);
});

test("A failed overview persistence rolls back both content and revision", (t) => {
  const { workspace } = fixture(t);
  const walk = create(workspace, { overview: body });
  t.mock.method(fs, "renameSync", () => {
    throw Error("Disk write failed");
  });
  assert.throws(
    () =>
      workspace.invoke("save_walkthrough_overview", {
        walkthroughId: walk.id,
        expectedRevision: walk.revision,
        overview: "Must not stick",
      }),
    /Disk write failed/
  );
  assert.deepEqual(workspace.invoke("get_walkthrough", { id: walk.id }), walk);
});

test("Authenticated CLI and restricted webview requests use the same overview operation", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cp-overview-http-"))
  );
  let service;
  t.after(async () => {
    await service?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  const walk = await callTool(root, "save_walkthrough", {
    title: "Empty manual guide",
    steps: [],
  });
  const saved = await callTool(root, "save_walkthrough_overview", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    overview: body,
  });
  assert.equal(saved.overview, body);
  const edited = await dispatchWebviewRequest(service, "/api/call", {
    name: "save_walkthrough_overview",
    arguments: {
      walkthroughId: walk.id,
      expectedRevision: saved.revision,
      overview: "## Revised mental model\n\nStill no source changes.",
    },
  });
  assert.match(edited.overview, /Revised mental model/);
  const revision = (await service.call("project_overview", {})).revision;
  await service.close();
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  assert.equal(
    (await service.call("get_walkthrough", { id: walk.id })).overview,
    edited.overview
  );
  assert.equal((await service.call("project_overview", {})).revision, revision);
});
