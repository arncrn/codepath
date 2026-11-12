import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

test("Read-only comparison leaves workspace, index, refs, config and saved source byte/mtime unchanged; annotation writes preserve all legacy records", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 8;\nunchanged\n");
  const side = (content) => ({
    file: "part.ts",
    content,
    provenance: "Fixture only",
    startLine: 1,
    endLine: 1,
    purpose: "Fixture purpose",
    notes: [],
    variables: [],
    notApplicable: {
      notes: "Fixture exception",
      variables: "Fixture exception",
    },
  });
  const legacy = await f.service.call("create_change_review", {
    id: "legacy",
    title: "Stored compatibility record",
    cards: [
      {
        id: "one",
        title: "One",
        beforeBehavior: "Before fixture",
        afterBehavior: "After fixture",
        reason: "Fixture difference",
        before: side("const amount = 7;\nunchanged\n"),
        after: side("const amount = 8;\nunchanged\n"),
      },
    ],
  });
  const walk = await f.service.call("save_walkthrough", {
    title: "Independent",
    steps: [
      {
        id: "step",
        title: "Independent",
        source: { file: "part.ts", startLine: 1, endLine: 1 },
      },
    ],
  });
  await f.service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "step",
    body: "Independent data",
    author: "Human",
  });
  const ordinary = await f.service.call("get_walkthrough", { id: walk.id });
  const files = [
    ".codepaths/workspace.json",
    ".git/index",
    ".git/config",
    ".git/HEAD",
    ".git/refs/heads/main",
    ".git/refs/heads/equal",
    "part.ts",
  ];
  const observe = () =>
    files.map((file) => ({
      bytes: fs.readFileSync(path.join(f.root, file)),
      mtime: fs.statSync(path.join(f.root, file)).mtimeMs,
    }));
  const before = observe();
  let list = await allChanges(f.service),
    selected = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: selected.id,
  });
  await f.service.call("list_git_branches", {});
  list = await allChanges(f.service, {
    mode: "compare",
    base: "refs/heads/equal",
    target: "WORKING_TREE",
  });
  await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: list.files[0].id,
  });
  assert.deepEqual(observe(), before);
  const saved = await f.service.call("save_comparison_note", {
    listId: view.listId,
    fileId: view.file.id,
    binding: view.binding,
    side: "after",
    expectedRevision: 0,
    body: "Human annotation",
    author: "Human",
    attachments: [],
  });
  await f.service.call("delete_comparison_note", {
    scope: view.scope,
    expectedRevision: saved.revision,
    noteId: saved.notes[0].id,
  });
  assert.deepEqual(
    (await f.service.call("get_change_review", { id: "legacy" })).cards,
    legacy.cards
  );
  assert.deepEqual(
    await f.service.call("get_walkthrough", { id: walk.id }),
    ordinary
  );
  assert.deepEqual(observe().slice(1), before.slice(1));
  await f.reopen();
  assert.equal(
    (await f.service.call("get_change_review", { id: "legacy" })).fingerprint,
    legacy.fingerprint
  );
});
