import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../dist/workspace.mjs";
import { tools } from "../dist/tools.mjs";
import { dispatchWebviewRequest } from "../dist/vscode/bridge.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-callback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function handle() { return 1; }\nexport function setup() { register(handle); }\nexport function dispatch(callback: () => number) { return callback(); }\n"
  );
  const workspace = openWorkspace(root);
  const steps = ["setup", "handle", "dispatch"].map((symbol, position) => ({
    id: "step-" + position,
    title: symbol,
    source: { file: "flow.ts", symbol },
    evidence: position === 1 ? "inferred" : "source",
    sample: { input: "illustrative" },
  }));
  return { root, workspace, steps };
}

function update(workspace, walkthrough, steps = walkthrough.steps) {
  return workspace.invoke("save_walkthrough", {
    id: walkthrough.id,
    title: walkthrough.title,
    description: walkthrough.description,
    expectedRevision: walkthrough.revision,
    steps,
  });
}

test("Explicit callback roles survive reload without changing source evidence, notes, focus or run provenance", (t) => {
  const { root, workspace, steps } = fixture(t);
  const roles = ["registration", "definition", "activation-call-site"];
  let walk = workspace.invoke("save_walkthrough", {
    title: "Callback source",
    steps: steps.map((step, position) => ({
      ...step,
      callbackRole: roles[position],
    })),
  });
  assert.deepEqual(
    walk.steps.map((step) => step.callbackRole),
    roles
  );
  const note = workspace.invoke("add_note", {
    walkthroughId: walk.id,
    stepId: steps[1].id,
    body: "A definition is not proof of invocation.",
    author: "Test",
  });
  const focus = workspace.invoke("focus_step", {
    walkthroughId: walk.id,
    stepId: steps[1].id,
  });
  const runs = ["example", "recorded"].map((mode) =>
    workspace.invoke("record_run", {
      walkthroughId: walk.id,
      label: mode,
      mode,
      origin: "Imported fixture, not executed by this test",
      events: [{ stepId: steps[2].id, output: 1 }],
    })
  );
  walk = workspace.invoke("get_walkthrough", { id: walk.id });
  const saved = update(
    workspace,
    walk,
    walk.steps.map((step) => ({ ...step, callbackRole: "definition" }))
  );
  assert.equal(saved.revision, walk.revision + 1);
  assert.deepEqual(
    saved.steps.map((step) => step.id),
    steps.map((step) => step.id)
  );
  assert.deepEqual(
    saved.steps.map((step) => step.source),
    walk.steps.map((step) => step.source)
  );
  assert.deepEqual(
    saved.steps.map((step) => step.snapshotHash),
    walk.steps.map((step) => step.snapshotHash)
  );
  assert.deepEqual(
    saved.steps.map((step) => step.evidence),
    steps.map((step) => step.evidence)
  );
  assert.equal(saved.steps[1].notes[0].id, note.id);
  assert.deepEqual(workspace.overview().focus, focus);
  const reopened = openWorkspace(root);
  assert.deepEqual(
    reopened
      .invoke("get_walkthrough", { id: walk.id })
      .steps.map((step) => step.callbackRole),
    ["definition", "definition", "definition"]
  );
  for (const run of runs)
    assert.deepEqual(
      reopened.invoke("get_run", { id: run.id }),
      JSON.parse(JSON.stringify(run))
    );
  const metadata = JSON.parse(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8")
  );
  metadata.paths[0].steps[1].notes[0].history = [
    { ...note, body: "Previous explanation" },
  ];
  fs.writeFileSync(
    path.join(root, ".codepaths/workspace.json"),
    JSON.stringify(metadata)
  );
  const withHistory = openWorkspace(root);
  const reviewed = withHistory.invoke("get_walkthrough", { id: walk.id });
  assert.deepEqual(
    update(withHistory, reviewed).steps[1].notes[0].history,
    metadata.paths[0].steps[1].notes[0].history
  );
});

test("Legacy absence stays absent, omitted updates retain roles, and null explicitly clears them", (t) => {
  const { root, workspace, steps } = fixture(t);
  let walk = workspace.invoke("save_walkthrough", { title: "Legacy", steps });
  assert.ok(walk.steps.every((step) => !("callbackRole" in step)));
  walk = update(
    workspace,
    walk,
    walk.steps.map((step) => ({ ...step, callbackRole: "registration" }))
  );
  walk = update(workspace, walk, steps);
  assert.ok(walk.steps.every((step) => step.callbackRole === "registration"));
  walk = update(
    workspace,
    walk,
    walk.steps.map((step) => ({ ...step, callbackRole: null }))
  );
  assert.ok(walk.steps.every((step) => !("callbackRole" in step)));
  assert.ok(
    openWorkspace(root)
      .invoke("get_walkthrough", { id: walk.id })
      .steps.every((step) => !("callbackRole" in step))
  );
});

test("Invalid tool roles reject the whole edit without persisting any change", (t) => {
  const { root, workspace, steps } = fixture(t);
  const walk = workspace.invoke("save_walkthrough", { title: "Roles", steps });
  const filename = path.join(root, ".codepaths/workspace.json");
  const before = fs.readFileSync(filename, "utf8");
  for (const role of [
    "executed",
    "callback",
    "",
    1,
    true,
    {},
    [],
    { role: "definition" },
  ]) {
    assert.throws(
      () =>
        update(workspace, walk, [
          { ...steps[0], callbackRole: "registration" },
          { ...steps[1], callbackRole: role },
        ]),
      /Invalid callback role/
    );
    assert.equal(fs.readFileSync(filename, "utf8"), before);
    assert.equal(
      workspace.invoke("get_walkthrough", { id: walk.id }).revision,
      walk.revision
    );
  }
});

test("Persisted callback metadata validates on open; old metadata remains supported", (t) => {
  const { root, workspace, steps } = fixture(t);
  workspace.invoke("save_walkthrough", { title: "Roles", steps });
  const filename = path.join(root, ".codepaths/workspace.json");
  const metadata = JSON.parse(fs.readFileSync(filename, "utf8"));
  for (const role of ["executed", null, 0, { role: "definition" }]) {
    metadata.paths[0].steps[0].callbackRole = role;
    fs.writeFileSync(filename, JSON.stringify(metadata));
    assert.throws(() => openWorkspace(root), /Invalid callback role/);
  }
  delete metadata.paths[0].steps[0].callbackRole;
  fs.writeFileSync(filename, JSON.stringify(metadata));
  assert.equal(openWorkspace(root).overview().paths.length, 1);
});

test("Roles cannot bypass revision checks or mark changed source fresh", (t) => {
  const { root, workspace, steps } = fixture(t);
  const walk = workspace.invoke("save_walkthrough", { title: "Roles", steps });
  workspace.invoke("add_note", {
    walkthroughId: walk.id,
    stepId: steps[0].id,
    body: "Keep this note",
    author: "Test",
  });
  assert.throws(
    () =>
      update(
        workspace,
        walk,
        walk.steps.map((step) => ({ ...step, callbackRole: "registration" }))
      ),
    /Path changed/
  );
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    fs
      .readFileSync(path.join(root, "flow.ts"), "utf8")
      .replace("register(handle)", "other(handle)")
  );
  const current = workspace.invoke("get_walkthrough", { id: walk.id });
  const saved = update(
    workspace,
    current,
    current.steps.map((step) => ({ ...step, callbackRole: "definition" }))
  );
  assert.equal(saved.steps[0].stale, true);
  assert.equal(saved.steps[0].notes[0].stale, true);
  assert.equal(saved.steps[0].snapshotHash, walk.steps[0].snapshotHash);
});

test("The restricted host bridge accepts explicit roles through the existing save operation", async (t) => {
  const { workspace, steps } = fixture(t);
  const service = {
    call: async (name, args) => workspace.invoke(name, args),
    request: async () => workspace.overview(),
  };
  const walk = await dispatchWebviewRequest(service, "/api/call", {
    name: "save_walkthrough",
    arguments: {
      title: "Host callback",
      steps: [{ ...steps[0], callbackRole: "registration" }],
    },
  });
  assert.equal(walk.steps[0].callbackRole, "registration");
  await assert.rejects(
    dispatchWebviewRequest(service, "/api/call", {
      name: "save_walkthrough",
      arguments: {
        title: "Invalid",
        steps: [{ ...steps[0], callbackRole: "executed" }],
      },
    }),
    /Invalid callback role/
  );
});

test("Published authoring schema exposes source roles and their no-execution limitation", () => {
  const save = tools.find((tool) => tool.name === "save_walkthrough");
  const role = save.inputSchema.properties.steps.items.properties.callbackRole;
  assert.deepEqual(role.type, ["string", "null"]);
  assert.deepEqual(role.enum, [
    "registration",
    "definition",
    "activation-call-site",
    null,
  ]);
  assert.match(role.description, /not.*execution/i);
  assert.match(role.description, /null.*clear/i);
});
