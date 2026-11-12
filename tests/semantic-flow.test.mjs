import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../dist/workspace.mjs";
import {
  mainSource,
  helperSource,
  fixtureSteps,
  fixtureGraph,
} from "./fixtures/semantic-flow.mjs";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-semantic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "main.mjs"), mainSource);
  fs.writeFileSync(path.join(root, "helper.mjs"), helperSource);
  const w = openWorkspace(root);
  const walk = w.invoke("save_walkthrough", {
    id: "semantic",
    title: "Actual branches and calls",
    steps: fixtureSteps,
  });
  return { w, walk, graph: fixtureGraph(walk) };
}
test("Public authored Flow retains source-supported branches, joins, loop, imported call, recursion and unresolved callback independently of card order", (t) => {
  const { w, walk, graph } = fixture(t);
  const saved = w.invoke("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph,
  });
  assert.deepEqual(saved.flow, graph);
  assert.equal(saved.flowState.status, "current");
  assert.deepEqual(
    saved.flowState.nodes.map(({ stepId, sourceHash, attachment }) => ({
      stepId,
      sourceHash,
      attachment,
    })),
    graph.nodes.map(({ stepId, sourceHash, attachment }) => ({
      stepId,
      sourceHash,
      attachment,
    })),
    "Every admitted displayed node carries its exact source target, including nodes sharing a card"
  );
  assert.equal(saved.flow.edges.filter((e) => e.from === "positive").length, 2);
  assert.deepEqual(
    saved.flow.edges
      .filter((e) =>
        ["loop", "call", "recursion", "unresolved"].includes(e.kind)
      )
      .map((e) => [e.from, e.to, e.kind]),
    [
      ["invoke", "base", "call"],
      ["join", "loop", "loop"],
      ["notify", "exit", "unresolved"],
      ["recur", "base", "recursion"],
    ]
  );
  const reordered = w.invoke("save_walkthrough", {
    ...saved,
    expectedRevision: saved.revision,
    steps: [saved.steps[1], saved.steps[0]],
  });
  assert.deepEqual(reordered.flow, graph);
  assert.equal(reordered.flowState.status, "current");
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        openWorkspace(w.root).invoke("get_walkthrough", { id: walk.id })
      )
    ),
    JSON.parse(JSON.stringify(reordered))
  );
});

test("Flow admission rejects stale revisions, unknown cards, wrong exact source, malformed references and explicit budgets without writes", (t) => {
  const { w, walk, graph } = fixture(t);
  const before = fs.readFileSync(path.join(w.dir, "workspace.json"), "utf8");
  const save = (value, expectedRevision = walk.revision) =>
    w.invoke("save_walkthrough_flow", {
      walkthroughId: walk.id,
      expectedRevision,
      graph: value,
    });
  assert.throws(() => save(graph, 0), /changed/);
  const cases = [
    [(g) => (g.nodes[0].stepId = "missing"), /source or linked cards/],
    [(g) => (g.nodes[0].sourceHash = "0".repeat(20)), /source or linked cards/],
    [(g) => (g.nodes[0].attachment.text = "other"), /source or linked cards/],
    [
      (g) => (g.nodes[0].attachment.fileHash = "0".repeat(20)),
      /source or linked cards/,
    ],
    [(g) => (g.nodes[0].attachment.startColumn = -1), /attachment range/],
    [(g) => (g.nodes[0].attachment.endColumn = 9999), /source or linked cards/],
    [(g) => (g.edges[0].to = "missing"), /endpoint/],
    [(g) => (g.edges[0].kind = "guess"), /edge kind/],
    [(g) => g.nodes.push({ ...g.nodes[0] }), /duplicate/],
    [(g) => g.edges.push({ ...g.edges[0] }), /duplicate/],
    [
      (g) =>
        (g.edges = g.edges.filter(
          (e) => !(e.from === "positive" && e.kind === "false")
        )),
      /true and one false/,
    ],
    [(g) => (g.nodes[0].kind = "arbitrary"), /node kind/],
    [(g) => (g.nodes[0].label = "x".repeat(301)), /oversized/],
    [
      (g) =>
        (g.nodes = Array.from({ length: 121 }, (_, i) => ({
          ...g.nodes[0],
          id: "n" + i,
        }))),
      /1–120/,
    ],
    [(g) => (g.edges = Array.from({ length: 241 }, () => g.edges[0])), /240/],
    [(g) => (g.oversized = "x".repeat(256 * 1024)), /256 KiB/],
  ];
  for (const [change, pattern] of cases) {
    const bad = structuredClone(graph);
    change(bad);
    assert.throws(() => save(bad), pattern);
    assert.equal(
      fs.readFileSync(path.join(w.dir, "workspace.json"), "utf8"),
      before
    );
  }
  assert.equal(
    w.invoke("get_walkthrough", { id: walk.id }).revision,
    walk.revision
  );
});

test("Currentness is read-only, exact full-file and selection bound, with no relocation or review of old purposes/notes", (t) => {
  const { w, walk, graph } = fixture(t);
  w.invoke("add_note", {
    walkthroughId: walk.id,
    stepId: "run",
    body: "Legacy note retained",
    author: "Original",
  });
  let current = w.invoke("get_walkthrough", { id: walk.id });
  const saved = w.invoke("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: current.revision,
    graph,
  });
  const before = fs.readFileSync(path.join(w.dir, "workspace.json"), "utf8");
  for (const changed of [
    mainSource + "// full-file changed\n",
    "// moved\n" + mainSource,
  ]) {
    fs.writeFileSync(path.join(w.root, "main.mjs"), changed);
    current = w.invoke("get_walkthrough", { id: walk.id });
    assert.equal(current.flowState.status, "stale");
    assert.equal(current.flowState.definition, undefined);
    assert.deepEqual(current.flow, graph);
    assert.equal(
      fs.readFileSync(path.join(w.dir, "workspace.json"), "utf8"),
      before
    );
  }
  fs.unlinkSync(path.join(w.root, "main.mjs"));
  assert.equal(
    w.invoke("get_walkthrough", { id: walk.id }).flowState.status,
    "stale"
  );
  fs.writeFileSync(path.join(w.root, "main.mjs"), mainSource);
  assert.equal(
    w.invoke("get_walkthrough", { id: walk.id }).flowState.status,
    "current"
  );
  // Changing actual displayed code makes the card purpose stale, but a fresh
  // explicitly authored graph uses code.hash, never the old reviewed snapshot.
  fs.writeFileSync(
    path.join(w.root, "main.mjs"),
    mainSource.replace("run(items, notify)", "run(items, notify = () => {})")
  );
  current = w.invoke("get_walkthrough", { id: walk.id });
  const refreshed = fixtureGraph(current);
  const after = w.invoke("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: current.revision,
    graph: refreshed,
  });
  assert.equal(after.flowState.status, "current");
  assert.equal(after.steps[0].stale, true);
  assert.equal(after.steps[0].snapshotHash, saved.steps[0].snapshotHash);
  assert.deepEqual(
    after.steps[0].notes,
    saved.steps[0].notes.map((n) => ({ ...n, stale: true }))
  );
});

test("Ordinary card/note/repair edits preserve authored graph; deleted card is stale, not silently pruned; clear is explicit", (t) => {
  const { w, walk, graph } = fixture(t);
  w.invoke("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph,
  });
  w.invoke("add_note", {
    walkthroughId: walk.id,
    stepId: "run",
    body: "Keep history",
    author: "Original",
  });
  let current = w.invoke("get_walkthrough", { id: walk.id });
  const code = current.steps[0].code;
  current = w.invoke("repair_step_source", {
    walkthroughId: walk.id,
    stepId: "run",
    expectedRevision: current.revision,
    source: { file: "main.mjs", startLine: 3, endLine: 4 },
    fileHash: code.fileHash,
  });
  assert.deepEqual(current.flow, graph);
  assert.equal(current.flowState.status, "stale");
  current = w.invoke("save_walkthrough", {
    ...current,
    expectedRevision: current.revision,
    steps: current.steps.filter((s) => s.id !== "helper"),
  });
  assert.deepEqual(current.flow, graph);
  assert.equal(
    openWorkspace(w.root).invoke("get_walkthrough", { id: walk.id }).flowState
      .status,
    "stale"
  );
  current = w.invoke("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: current.revision,
    graph: null,
  });
  assert.equal(current.flow, undefined);
  assert.equal(current.flowState.status, "absent");
  assert.equal(current.steps[0].notes[0].body, "Keep history");
});

test("Exact maximum graph budgets retain every explicitly supplied node and edge", (t) => {
  const { w, walk, graph } = fixture(t);
  // Deliberately synthetic topology for admission budgets, NOT a semantic code
  // fixture or a claim of execution. Behavioral correspondence is tested above.
  const nodes = Array.from({ length: 120 }, (_, i) => ({
    ...graph.nodes[0],
    id: "n" + i,
    kind: "process",
    label: "Budget node " + i,
  }));
  const edges = [];
  for (let i = 0; i < 120; i++) {
    edges.push({
      from: "n" + i,
      to: "n" + ((i + 1) % 120),
      kind: "next",
      label: "",
      basis: "Synthetic structural budget test, not a source-flow claim.",
    });
    edges.push({
      from: "n" + i,
      to: "n" + ((i + 2) % 120),
      kind: "next",
      label: "",
      basis: "Synthetic structural budget test, not a source-flow claim.",
    });
  }
  const saved = w.invoke("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph: {
      version: 1,
      summary: "Synthetic admission-budget test, not semantic evidence.",
      nodes,
      edges,
    },
  });
  assert.equal(saved.flow.nodes.length, 120);
  assert.equal(saved.flow.edges.length, 240);
  assert.deepEqual(saved.flow.nodes, nodes);
  assert.deepEqual(saved.flow.edges, edges);
});

test("Flow writes roll back memory and persisted legacy fields on synchronous save failure", (t) => {
  const { w, walk, graph } = fixture(t);
  const file = path.join(w.dir, "workspace.json"),
    backup = file + ".backup";
  const original = fs.readFileSync(file, "utf8");
  fs.renameSync(file, backup);
  fs.mkdirSync(file);
  try {
    assert.throws(() =>
      w.invoke("save_walkthrough_flow", {
        walkthroughId: walk.id,
        expectedRevision: walk.revision,
        graph,
      })
    );
    assert.equal(
      w.invoke("get_walkthrough", { id: walk.id }).flowState.status,
      "absent"
    );
    assert.equal(
      w.invoke("get_walkthrough", { id: walk.id }).revision,
      walk.revision
    );
  } finally {
    fs.rmdirSync(file);
    fs.renameSync(backup, file);
  }
  assert.equal(fs.readFileSync(file, "utf8"), original);
  const persisted = JSON.parse(original);
  persisted.paths[0].legacyField = { kept: true };
  persisted.paths[0].steps[0].legacyStepField = "retained";
  fs.writeFileSync(file, JSON.stringify(persisted));
  const reload = openWorkspace(w.root);
  const current = reload.invoke("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph,
  });
  const updated = reload.invoke("save_walkthrough", {
    ...current,
    expectedRevision: current.revision,
    steps: current.steps,
  });
  assert.deepEqual(updated.legacyField, { kept: true });
  assert.equal(updated.steps[0].legacyStepField, "retained");
});

test("Reload validates saved graph structure but accepts unavailable references as stale; legacy absence does not change authoring readiness", (t) => {
  const { w, walk, graph } = fixture(t);
  const readiness = w.invoke("validate_walkthrough", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
  });
  assert.ok(readiness.issues.every((issue) => !issue.code.includes("flow")));
  const saved = w.invoke("save_walkthrough_flow", {
    walkthroughId: walk.id,
    expectedRevision: walk.revision,
    graph,
  });
  const file = path.join(w.dir, "workspace.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.paths[0].flow.edges[0].to = "absent";
  fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => openWorkspace(w.root), /unknown edge endpoint/);
  data.paths[0].flow = saved.flow;
  data.paths[0].steps = [];
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(
    openWorkspace(w.root).invoke("get_walkthrough", { id: walk.id }).flowState
      .status,
    "stale"
  );
});
