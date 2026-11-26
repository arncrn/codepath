import { test } from "node:test";
import assert from "node:assert/strict";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";
import {
  composeReviewFixture,
  reviewMarkdown,
} from "./fixtures/composed-review.mjs";

test("Composed Git cards project each historical side's selected lexical owner without live-source rebinding or reader saves", async (t) => {
  const f = await gitProject(t);
  const { saved, ordinary } = await composeReviewFixture(f);
  assert.deepEqual(
    saved.steps.map((step) => [
      step.before.code.functionContext?.name,
      step.after.code.functionContext?.name,
    ]),
    [
      ["beforeOrder", "indexOrder"],
      ["beforeOrder › anonymous", "indexOrder › anonymous"],
    ]
  );
  assert.equal(ordinary.steps[0].code.functionContext.name, "liveOrder");
  for (const step of saved.steps)
    for (const side of ["before", "after"]) {
      assert.equal(
        step.annotations.notes.find(
          (note) => note.side === side && !note.variableName
        ).body,
        reviewMarkdown
      );
      assert.equal(
        step.annotations.notes.find(
          (note) => note.side === side && note.variableName
        ).body,
        reviewMarkdown
      );
    }
  // Ordinary current names and stale explanations remain independent of B.
  f.write(
    "composed.ts",
    "function renamedLive() {\n  const amount = 9;\n  items.map((item) => {\n    return amount - item;\n  });\n  return amount;\n}\n"
  );
  const current = await f.service.call("get_walkthrough", { id: ordinary.id });
  assert.equal(current.steps[0].code.functionContext.name, "renamedLive");
  assert.equal(current.steps[0].stale, true);
  assert.equal(current.steps[0].snapshotHash, ordinary.steps[0].snapshotHash);
  assert.equal(current.steps[0].explanation, "Original ordinary purpose");
  await f.reopen();
  const revision = (await f.service.call("project_overview", {})).revision;
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  assert.equal(
    (await f.service.call("project_overview", {})).revision,
    revision
  );
});

test("Go comparison cards resolve generic methods and callbacks from each historical side, not the live file", async (t) => {
  const f = await gitProject(t);
  const source =
    "package main\ntype Store[T any] struct{}\nfunc (s *Store[T]) Before(callback func()) {\n  callback()\n  func() {\n    println(1)\n  }()\n}\n";
  f.write("store.go", source);
  f.git("add", "--", "store.go");
  f.git("commit", "--quiet", "-m", "Go scopes before");
  f.write("store.go", source.replace("Before", "After"));
  f.git("add", "--", "store.go");
  f.write("store.go", source.replace("Before", "Live"));
  const list = await allChanges(f.service);
  const file = list.files.find(
    (file) => file.file === "store.go" && file.group === "staged"
  );
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const side = (line) => ({
    title: "Not a function name",
    purpose: "Authored purpose",
    startLine: line,
    endLine: line,
    notes: [],
    variables: [],
    notApplicable: {
      notes: "No block note needed in this fixture.",
      variables: "No variable explanation needed in this fixture.",
    },
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Go historical scopes",
    listId: list.listId,
    steps: [4, 6].map((line) => ({
      id: "line-" + line,
      title: "Historical context",
      fileId: file.id,
      binding: view.binding,
      before: side(line),
      after: side(line),
    })),
  });
  assert.deepEqual(
    saved.steps.map((step) => [
      step.before.code.functionContext.name,
      step.after.code.functionContext.name,
    ]),
    [
      ["Store.Before", "Store.After"],
      ["Store.Before › anonymous", "Store.After › anonymous"],
    ]
  );
  await f.reopen();
  const revision = (await f.service.call("project_overview", {})).revision;
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  assert.equal(
    (await f.service.call("project_overview", {})).revision,
    revision
  );
});

test("Empty and unsupported historical sides keep honest context rather than guessing from source-looking text", async (t) => {
  const f = await gitProject(t);
  const samples = [
    ["empty.ts", "", 0, "empty selection"],
    [
      "plain.txt",
      "function looksReal() { return 1; }",
      1,
      "unsupported or invalid source",
    ],
    [
      "broken.ts",
      "function broken( {\n  return 1;\n",
      2,
      "unsupported or invalid source",
    ],
    [
      "broken.go",
      "package main\nfunc outer() {\n  fn := func() {\n    println(1)\n",
      4,
      "unsupported or invalid source",
    ],
  ];
  for (const [file, text] of samples) f.write(file, text);
  const list = await allChanges(f.service);
  const steps = [];
  for (const [index, [name, , line]] of samples.entries()) {
    const file = list.files.find((file) => file.file === name);
    const view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
    const side = (line) => ({
      title: name,
      purpose: "No inferred lexical claim",
      startLine: line,
      endLine: line,
      notes: [],
      variables: [],
      notApplicable: {
        notes: "No block explanation authored for this exact selected source.",
        variables:
          "No identifier explanation authored for this exact selected source.",
      },
    });
    steps.push({
      id: "edge-" + index,
      title: name,
      fileId: file.id,
      binding: view.binding,
      before: side(0),
      after: side(line),
    });
  }
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Honest source contexts",
    listId: list.listId,
    steps,
  });
  for (const [index, [, , , reason]] of samples.entries()) {
    assert.deepEqual(saved.steps[index].before.code.functionContext, {
      status: "unknown",
      reason: "empty selection",
    });
    assert.deepEqual(saved.steps[index].after.code.functionContext, {
      status: "unknown",
      reason,
    });
  }
});
