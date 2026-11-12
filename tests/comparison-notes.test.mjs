import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

async function selected(f) {
  const list = await allChanges(f.service);
  return f.service.call("get_git_file", {
    listId: list.listId,
    fileId: list.files.find(
      (file) => file.file === "part.ts" && file.group === "unstaged"
    ).id,
  });
}
function args(view, side = "before") {
  const code = view[side].code;
  return {
    listId: view.listId,
    fileId: view.file.id,
    binding: view.binding,
    side,
    expectedRevision: view.annotations.revision,
    body: "Explain amount",
    author: "Human",
    variableName: "amount",
    attachments: [
      {
        file: code.file,
        fileHash: code.fileHash,
        startLine: 1,
        endLine: 1,
        startColumn: 6,
        endColumn: 12,
        text: "amount",
      },
    ],
  };
}
test("Comparison annotations create/read/edit/delete/reopen on exact sides; IDs/history and other data survive without source review on delete", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 4;\nunchanged\n");
  let view = await selected(f);
  const input = args(view);
  let saved = await f.service.call("save_comparison_note", input);
  assert.equal(saved.revision, 1);
  const note = saved.notes[0];
  assert.equal(note.side, "before");
  assert.equal(note.attachments[0].fileHash, view.before.code.fileHash);
  assert.equal(note.binding, view.binding);
  await assert.rejects(
    f.service.call("save_comparison_note", { ...input, side: "after" }),
    /revision|changed/i
  );
  view = await selected(f);
  await assert.rejects(
    f.service.call("save_comparison_note", {
      ...args(view),
      variableName: "mount",
    }),
    /identifier/i
  );
  await assert.rejects(
    f.service.call("save_comparison_note", { ...args(view), side: "after" }),
    /attachment/i
  );
  saved = await f.service.call("save_comparison_note", {
    ...args(view),
    noteId: note.id,
    body: "Correct explanation",
  });
  assert.equal(saved.notes[0].id, note.id);
  assert.equal(saved.notes[0].history[0].body, "Explain amount");
  assert.equal(saved.notes[0].history[0].binding, view.binding);
  await f.reopen();
  view = await selected(f);
  assert.equal(view.annotations.notes[0].body, "Correct explanation");
  f.write("part.ts", "const amount = 5;\nunchanged\n");
  await assert.rejects(
    f.service.call("save_comparison_note", { ...args(view), noteId: note.id }),
    /changed/i
  );
  const newer = await selected(f);
  assert.equal(newer.annotations.notes[0].stale, true);
  await assert.rejects(
    f.service.call("save_comparison_note", { ...args(newer), noteId: note.id }),
    /different|stale|changed/i
  );
  const independent = await f.service.call("save_comparison_note", {
    ...args(newer),
    body: "Fresh separately bound annotation",
  });
  assert.equal(
    independent.notes[0].stale,
    true,
    "Saving a new note must not make the earlier binding current, even if its own side's text is unchanged."
  );
  assert.equal(independent.notes[0].id, note.id);
  fs.unlinkSync(path.join(f.root, "part.ts"));
  const deletion = {
    scope: view.scope,
    noteId: note.id,
    expectedRevision: independent.revision,
  };
  const temp = path.join(
    f.root,
    `.codepaths/workspace.json.${process.pid}.tmp`
  );
  fs.mkdirSync(temp);
  await assert.rejects(
    f.service.call("delete_comparison_note", deletion),
    /EISDIR/
  );
  fs.rmdirSync(temp);
  await assert.rejects(
    f.service.call("delete_comparison_note", { ...deletion, scope: "wrong" }),
    /scope|found/i
  );
  saved = await f.service.call("delete_comparison_note", deletion);
  assert.equal(saved.notes[0].archived, true);
  assert.equal(saved.notes[0].hash, note.hash);
  assert.equal(saved.notes[0].binding, note.binding);
  assert.equal(saved.notes[0].history.length, 2);
  assert.equal(saved.notes[1].id, independent.notes[1].id);
  assert.equal(saved.notes[1].archived, undefined);
  await f.reopen();
  const missing = await selected(f);
  assert.equal(missing.annotations.notes[0].archived, true);
});
