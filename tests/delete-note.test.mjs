import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startProjectService } from "../dist/service.mjs";

test("Delete note removes only the active entry, preserving identity/history/source binding even when source is missing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-delete-note-"));
  fs.writeFileSync(path.join(root, "a.ts"), "const value = 1;\n");
  let service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const walk = await service.call("save_walkthrough", {
    title: "Read",
    steps: [
      {
        id: "one",
        title: "One",
        source: { file: "a.ts", startLine: 1, endLine: 1 },
      },
    ],
  });
  const note = await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "one",
    body: "Keep history",
    author: "Human",
  });
  const other = await service.call("add_note", {
    walkthroughId: walk.id,
    stepId: "one",
    body: "Unrelated",
    author: "Human",
  });
  const firstRead = await service.call("get_walkthrough", { id: walk.id });
  const code = firstRead.steps[0].code;
  const variable = await service.call("add_reviewed_note", {
    walkthroughId: walk.id,
    stepId: "one",
    expectedRevision: firstRead.revision,
    sourceHash: code.hash,
    fileHash: code.fileHash,
    body: "Variable meaning",
    author: "Human",
    variableName: "value",
    attachments: [
      {
        file: "a.ts",
        fileHash: code.fileHash,
        startLine: 1,
        endLine: 1,
        startColumn: 6,
        endColumn: 11,
        text: "value",
      },
    ],
  });
  const current = await service.call("get_walkthrough", { id: walk.id });
  fs.unlinkSync(path.join(root, "a.ts"));
  const args = {
    walkthroughId: walk.id,
    stepId: "one",
    noteId: note.id,
    expectedRevision: current.revision,
  };
  await assert.rejects(
    service.call("delete_note", { ...args, expectedRevision: walk.revision }),
    /changed/i
  );
  const temporary = path.join(
    root,
    `.codepaths/workspace.json.${process.pid}.tmp`
  );
  fs.mkdirSync(temporary);
  await assert.rejects(service.call("delete_note", args), /EISDIR/);
  assert.equal(
    (await service.call("get_walkthrough", { id: walk.id })).revision,
    current.revision
  );
  fs.rmdirSync(temporary);
  const deleted = await service.call("delete_note", args);
  assert.equal(deleted.id, note.id);
  assert.equal(deleted.archived, true);
  assert.equal(deleted.hash, note.hash);
  assert.equal(deleted.body, note.body);
  assert.deepEqual(deleted.history, [
    { body: note.body, author: note.author, at: note.at, hash: note.hash },
  ]);
  await assert.rejects(
    service.call("delete_note", {
      ...args,
      expectedRevision: current.revision + 1,
      stepId: "wrong",
    }),
    /step/i
  );
  const deletedVariable = await service.call("delete_note", {
    ...args,
    noteId: variable.id,
    expectedRevision: current.revision + 1,
  });
  assert.equal(deletedVariable.variableName, "value");
  assert.deepEqual(deletedVariable.attachments, variable.attachments);
  assert.equal(deletedVariable.hash, variable.hash);
  await service.close();
  service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  const reopened = await service.call("get_walkthrough", { id: walk.id });
  assert.deepEqual(reopened.steps[0].notes, [deleted, other, deletedVariable]);
});
