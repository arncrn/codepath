import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openWorkspace } from "../dist/workspace.mjs";
import { indexProject } from "../dist/indexer.mjs";
import { buildSourceUsageIndex } from "../dist/source-usage.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-usages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source =
    "export function shared() {\n  return 1;\n}\nexport function other() { return 2; }\n";
  fs.writeFileSync(path.join(root, "flow.ts"), source);
  fs.writeFileSync(path.join(root, "separate.ts"), source);
  const workspace = openWorkspace(root);
  const save = (id, steps, expectedRevision) =>
    workspace.invoke("save_walkthrough", {
      id,
      title: id.toUpperCase(),
      steps: steps.map(([id, source]) => ({ id, title: id, source })),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  const query = (walkthroughId = "a") =>
    workspace.invoke("source_usages", { walkthroughId });
  return { root, source, workspace, save, query };
}
const shared = { file: "flow.ts", symbol: "shared" };

test("batch usages distinguish identical source, overlap and separate files", (t) => {
  const { save, query } = fixture(t);
  save("a", [
    ["a1", shared],
    ["a2", shared],
  ]);
  save("b", [
    ["b1", { file: "flow.ts", startLine: 1, endLine: 3 }],
    ["overlap", { file: "flow.ts", startLine: 2, endLine: 4 }],
    ["elsewhere", { file: "separate.ts", symbol: "shared" }],
  ]);
  const result = query();
  assert.equal(result.steps.length, 2);
  const first = result.steps[0];
  assert.equal(first.status, "resolved");
  assert.deepEqual(
    first.exact.map((usage) => usage.stepId),
    ["a1", "a2", "b1"]
  );
  assert.deepEqual(
    first.overlapping.map((usage) => usage.stepId),
    ["overlap"]
  );
  assert.deepEqual(first.identity, {
    file: "flow.ts",
    startLine: 1,
    endLine: 3,
  });
  assert.equal(result.unresolved.length, 0);
});

test("Empty-line selections retain exact usages and distinct repeated steps", (t) => {
  const { save, query } = fixture(t);
  const empty = { file: "flow.ts", startLine: 5, endLine: 5 };
  const saved = save("a", [
    ["empty-one", empty],
    ["empty-two", empty],
  ]);
  save("b", [["empty-other-path", empty]]);
  assert.equal(saved.steps[0].source.excerpt, "");
  const result = query();
  assert.equal(result.unresolved.length, 0);
  for (const step of result.steps) {
    assert.equal(step.status, "resolved");
    assert.deepEqual(
      step.exact.map((usage) => usage.stepId),
      ["empty-one", "empty-two", "empty-other-path"]
    );
  }
});

test("updates, removed steps and deleted paths leave no stale backlinks or writes", (t) => {
  const { root, workspace, save, query } = fixture(t);
  save("a", [["a1", shared]]);
  save("b", [
    ["b1", shared],
    ["b2", shared],
  ]);
  workspace.invoke("add_note", {
    walkthroughId: "b",
    stepId: "b1",
    body: "Independent",
    author: "test",
  });
  let b = workspace.invoke("get_walkthrough", { id: "b" });
  b = save("b", [["b1", { file: "flow.ts", symbol: "other" }]], b.revision);
  assert.deepEqual(
    query().steps[0].exact.map((usage) => usage.stepId),
    ["a1"]
  );
  assert.equal(b.steps[0].notes[0].body, "Independent");
  b = save("b", [["b1", shared]], b.revision);
  assert.equal(query().steps[0].exact.length, 2);
  workspace.invoke("delete_walkthrough", {
    id: "b",
    expectedRevision: b.revision,
  });
  const before = fs.readFileSync(
    path.join(root, ".codepaths/workspace.json"),
    "utf8"
  );
  assert.deepEqual(
    query().steps[0].exact.map((usage) => usage.stepId),
    ["a1"]
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".codepaths/workspace.json"), "utf8"),
    before
  );
});

test("unique excerpts and symbols relocate while ambiguous or missing references stay unresolved", (t) => {
  const { root, source, save, query } = fixture(t);
  save("a", [
    ["symbol", shared],
    ["range", { file: "flow.ts", startLine: 1, endLine: 3 }],
  ]);
  fs.writeFileSync(path.join(root, "flow.ts"), "// shifted\n" + source);
  let result = query();
  assert.equal(result.steps[0].identity.startLine, 2);
  assert.equal(result.steps[0].exact.length, 2);
  fs.writeFileSync(path.join(root, "flow.ts"), source + source);
  result = query();
  assert.ok(result.steps.every((step) => step.status === "unresolved"));
  assert.equal(result.unresolved.length, 2);
  assert.match(result.steps[0].error, /ambiguous/i);
  assert.match(result.steps[1].error, /ambiguous/i);
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export const replacement = 0;\n"
  );
  result = query();
  assert.ok(result.steps.every((step) => step.status === "unresolved"));
});

test("same-named symbols in different scopes do not collapse", (t) => {
  const { root, save, query } = fixture(t);
  fs.writeFileSync(
    path.join(root, "scopes.ts"),
    "function first() {\n function local() { return 1; }\n}\nfunction second() {\n function local() { return 2; }\n}\n"
  );
  save("a", [
    ["first", { file: "scopes.ts", startLine: 2, endLine: 2 }],
    ["second", { file: "scopes.ts", startLine: 5, endLine: 5 }],
  ]);
  let result = query();
  assert.deepEqual(
    result.steps.map((step) => step.exact.length),
    [1, 1]
  );
  const paths = [
    {
      id: "a",
      title: "A",
      steps: [
        {
          id: "ambiguous",
          title: "Ambiguous",
          source: { file: "scopes.ts", symbol: "local" },
        },
      ],
    },
  ];
  result = buildSourceUsageIndex(
    root,
    indexProject(root),
    paths
  ).forWalkthrough("a");
  assert.equal(result.steps[0].status, "unresolved");
  assert.match(result.steps[0].error, /ambiguous/i);
});

test("canonical aliases match but external symlinks and invalid persisted source never match", (t) => {
  const { root, save } = fixture(t);
  save("a", [["a1", shared]]);
  fs.symlinkSync(path.join(root, "flow.ts"), path.join(root, "alias.ts"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cp-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = 1;");
  fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "escape.ts"));
  const paths = [
    {
      id: "a",
      title: "A",
      steps: [
        { id: "real", title: "Real", source: shared },
        {
          id: "alias",
          title: "Alias",
          source: { file: "alias.ts", symbol: "shared" },
        },
        {
          id: "escape",
          title: "Escape",
          source: { file: "escape.ts", startLine: 1, endLine: 1 },
        },
        { id: "invalid", title: "Invalid", source: { file: 123 } },
        {
          id: "traversal",
          title: "Traversal",
          source: { file: "../secret.ts", startLine: 1, endLine: 1 },
        },
      ],
    },
  ];
  const result = buildSourceUsageIndex(
    root,
    indexProject(root),
    paths
  ).forWalkthrough("a");
  assert.equal(result.steps[0].exact.length, 2);
  assert.equal(result.steps[1].identity.file, "flow.ts");
  assert.equal(result.unresolved.length, 3);
  assert.ok(
    result.steps.slice(2).every((step) => step.status === "unresolved")
  );
});

test("file moves remain unresolved until references are explicitly updated and survive reopen", (t) => {
  const { root, workspace, save, query } = fixture(t);
  save("a", [["a1", shared]]);
  save("b", [["b1", shared]]);
  fs.renameSync(path.join(root, "flow.ts"), path.join(root, "moved.ts"));
  assert.equal(query().steps[0].status, "unresolved");
  assert.equal(query().unresolved.length, 2);
  for (const id of ["a", "b"]) {
    const saved = workspace.invoke("get_walkthrough", { id });
    save(
      id,
      [[id + "1", { file: "moved.ts", symbol: "shared" }]],
      saved.revision
    );
  }
  const reopened = openWorkspace(root).invoke("source_usages", {
    walkthroughId: "a",
  });
  assert.equal(reopened.steps[0].identity.file, "moved.ts");
  assert.deepEqual(
    reopened.steps[0].exact.map((usage) => usage.stepId),
    ["a1", "b1"]
  );
  assert.equal(reopened.unresolved.length, 0);
});

test("query validates tool input and persisted location identifiers", (t) => {
  const { root, workspace, save } = fixture(t);
  save("a", [["a1", shared]]);
  for (const walkthroughId of [null, 42, {}, "", "../a"]) {
    assert.throws(
      () => workspace.invoke("source_usages", { walkthroughId }),
      /Invalid walkthrough ID/
    );
  }
  assert.throws(
    () => workspace.invoke("source_usages", { walkthroughId: "missing" }),
    /not found/i
  );
  assert.throws(
    () =>
      buildSourceUsageIndex(root, indexProject(root), [
        {
          id: "a",
          title: "A",
          steps: [{ id: "../bad", title: "Bad", source: shared }],
        },
      ]),
    /saved source usage/i
  );
});
