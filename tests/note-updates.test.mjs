import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../dist/workspace.mjs";
import { startProjectService } from "../dist/service.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-notes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function run() { return 1; }\n"
  );
  const w = openWorkspace(root);
  const walk = w.invoke("save_walkthrough", {
    title: "Read run",
    steps: [
      { id: "run", title: "Run", source: { file: "flow.ts", symbol: "run" } },
    ],
  });
  const note = w.invoke("add_note", {
    walkthroughId: walk.id,
    stepId: "run",
    author: "Original agent",
    body: "Old setup commentary.",
  });
  const current = w.invoke("get_walkthrough", { id: walk.id });
  const batch = {
    id: "learning-update",
    updates: [
      {
        walkthroughId: walk.id,
        stepId: "run",
        noteId: note.id,
        oldBody: note.body,
        oldHash: note.hash,
        newBody: "run returns the number 1.",
        sourceHash: current.steps[0].code.hash,
        author: "Learning guide",
      },
    ],
  };
  const queue = () =>
    fs.writeFileSync(
      path.join(w.dir, "pending-note-updates.json"),
      JSON.stringify(batch)
    );
  return { root, w, walk, note, batch, queue };
}
test("Reviewed note replacement retains identity/history and advances revisions once", (t) => {
  const { w, walk, note, queue } = fixture(t);
  queue();
  const revision = w.invoke("get_walkthrough", { id: walk.id }).revision;
  assert.equal(w.applyPendingNoteUpdates(), 1);
  const after = w.invoke("get_walkthrough", { id: walk.id });
  assert.equal(after.revision, revision + 1);
  assert.equal(after.steps[0].notes.length, 1);
  const updated = after.steps[0].notes[0];
  assert.equal(updated.id, note.id);
  assert.equal(updated.body, "run returns the number 1.");
  assert.equal(updated.stale, false);
  assert.deepEqual(updated.history, [
    { body: note.body, author: note.author, at: note.at, hash: note.hash },
  ]);
  assert.ok(
    fs.existsSync(path.join(w.dir, "note-updates-learning-update.applied.json"))
  );
  queue();
  assert.equal(w.applyPendingNoteUpdates(), 0);
  assert.equal(
    w.invoke("get_walkthrough", { id: walk.id }).revision,
    after.revision
  );
});
test("Changed code or changed note blocks the whole batch without falsely revalidating", (t) => {
  const { root, w, walk, batch, queue, note } = fixture(t);
  queue();
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function run() { return 2; }\n"
  );
  assert.equal(w.applyPendingNoteUpdates(), 0);
  assert.equal(
    w.invoke("get_walkthrough", { id: walk.id }).steps[0].notes[0].body,
    note.body
  );
  assert.match(
    w.overview().index.warnings.join("\n"),
    /explanations.*Source changed/i
  );
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function run() { return 1; }\n"
  );
  batch.updates[0].oldBody = "Not the saved note";
  queue();
  assert.equal(w.applyPendingNoteUpdates(), 0);
  assert.equal(
    w.invoke("get_walkthrough", { id: walk.id }).steps[0].notes[0].hash,
    note.hash
  );
});
test("Invalid later edit does not partially replace earlier notes", (t) => {
  const { w, walk, batch, queue, note } = fixture(t);
  batch.updates.push({ ...batch.updates[0], noteId: "missing" });
  queue();
  assert.equal(w.applyPendingNoteUpdates(), 0);
  assert.equal(
    w.invoke("get_walkthrough", { id: walk.id }).steps[0].notes[0].body,
    note.body
  );
  assert.ok(fs.existsSync(path.join(w.dir, "pending-note-updates.json")));
});
test("Persistence failure leaves both live and stored notes unchanged", (t) => {
  const { w, walk, queue, note } = fixture(t);
  queue();
  const file = path.join(w.dir, "workspace.json"),
    backup = file + ".before";
  fs.renameSync(file, backup);
  fs.mkdirSync(file);
  assert.equal(w.applyPendingNoteUpdates(), 0);
  assert.equal(
    w.invoke("get_walkthrough", { id: walk.id }).steps[0].notes[0].body,
    note.body
  );
  assert.equal(
    JSON.parse(fs.readFileSync(backup, "utf8")).paths[0].steps[0].notes[0].body,
    note.body
  );
});
test("Pending updates reject symlinks and do not run while attaching to another owner", async (t) => {
  const { root, w, walk, note, batch } = fixture(t);
  const owner = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(() => owner.close());
  fs.writeFileSync(
    path.join(w.dir, "pending-note-updates.json"),
    JSON.stringify(batch)
  );
  const attached = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
    reuse: true,
  });
  assert.equal(attached.owned, false);
  await attached.close();
  assert.equal(
    (await owner.call("get_walkthrough", { id: walk.id })).steps[0].notes[0]
      .body,
    note.body
  );
  await owner.close();
  const next = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(() => next.close());
  assert.equal(
    (await next.call("get_walkthrough", { id: walk.id })).steps[0].notes[0]
      .body,
    "run returns the number 1."
  );
  await next.close();
  const destination = path.join(root, "not-a-queue.json");
  fs.writeFileSync(destination, JSON.stringify(batch));
  fs.symlinkSync(destination, path.join(w.dir, "pending-note-updates.json"));
  assert.equal(openWorkspace(root).applyPendingNoteUpdates(), 0);
  assert.equal(fs.readFileSync(destination, "utf8"), JSON.stringify(batch));
});
