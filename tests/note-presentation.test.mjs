import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../dist/workspace.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "codepath-note-presentation-")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function run() {\n  const value = 1;\n  return value;\n}\n"
  );
  const workspace = openWorkspace(root);
  const created = workspace.invoke("save_walkthrough", {
    title: "Presentation",
    steps: [
      {
        id: "run",
        title: "Run",
        source: { file: "flow.ts", symbol: "run" },
        explanation: "Purpose",
      },
    ],
  });
  const current = () => workspace.invoke("get_walkthrough", { id: created.id });
  const review = () => {
    const p = current(),
      code = p.steps[0].code;
    return {
      walkthroughId: p.id,
      stepId: "run",
      expectedRevision: p.revision,
      sourceHash: code.hash,
      fileHash: code.fileHash,
      body: "Keeps the result to return to the caller.",
      author: "Reviewer",
      attachments: [
        {
          file: "flow.ts",
          fileHash: code.fileHash,
          startLine: 2,
          startColumn: 8,
          endLine: 2,
          endColumn: 13,
          text: "value",
        },
      ],
    };
  };
  const reopen = () =>
    openWorkspace(root).invoke("get_walkthrough", { id: created.id });
  return { root, workspace, current, review, reopen };
}
test("note presentation is explicit, backward compatible and persisted", (t) => {
  const f = fixture(t);
  const plain = f.workspace.invoke("add_reviewed_note", f.review());
  assert.equal(
    plain.variableName,
    undefined,
    "A one-word attachment does not imply a variable explanation"
  );
  const variable = f.workspace.invoke("add_reviewed_note", {
    ...f.review(),
    variableName: "value",
  });
  assert.equal(variable.variableName, "value");
  assert.equal(f.reopen().steps[0].notes[1].variableName, "value");
  assert.equal(f.workspace.overview().capabilities.notePresentation, true);
});
test("classification changes preserve prior metadata and omission is not a reset", (t) => {
  const f = fixture(t),
    original = f.workspace.invoke("add_reviewed_note", {
      ...f.review(),
      variableName: "value",
    });
  const edited = f.workspace.invoke("review_note", {
    ...f.review(),
    noteId: original.id,
    body: "A corrected purpose.",
  });
  assert.equal(edited.variableName, "value");
  assert.equal(edited.history[0].variableName, "value");
  const block = f.workspace.invoke("review_note", {
    ...f.review(),
    noteId: original.id,
    variableName: null,
    attachments: [],
  });
  assert.equal(block.variableName, undefined);
  assert.equal(block.history.at(-1).variableName, "value");
  assert.equal(f.reopen().steps[0].notes[0].variableName, undefined);
});
test("archiving is reversible and retains identity, body and review history", (t) => {
  const f = fixture(t),
    original = f.workspace.invoke("add_reviewed_note", {
      ...f.review(),
      variableName: "value",
    });
  const archived = f.workspace.invoke("review_note", {
    ...f.review(),
    noteId: original.id,
    archived: true,
  });
  assert.equal(archived.archived, true);
  assert.equal(archived.id, original.id);
  assert.equal(archived.body, original.body);
  assert.equal(f.reopen().steps[0].notes[0].archived, true);
  const restored = f.workspace.invoke("review_note", {
    ...f.review(),
    noteId: original.id,
    archived: false,
  });
  assert.equal(restored.archived, false);
  assert.equal(restored.history.at(-1).archived, true);
  assert.equal(restored.history.at(-1).variableName, "value");
});
test("invalid presentation metadata and unbound variable names make no writes", (t) => {
  const f = fixture(t),
    file = path.join(f.root, ".codepaths/workspace.json"),
    before = fs.readFileSync(file, "utf8");
  for (const metadata of [
    { variableName: "" },
    { variableName: 4 },
    { variableName: "two names" },
    { variableName: "other" },
    { variableName: "value", attachments: [] },
    { archived: "true" },
  ]) {
    assert.throws(
      () =>
        f.workspace.invoke("add_reviewed_note", { ...f.review(), ...metadata }),
      /variable|archiv/i
    );
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
});
test("a variable target cannot select only the middle of another identifier", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(
    path.join(f.root, ".codepaths/workspace.json"),
    "utf8"
  );
  assert.throws(
    () =>
      f.workspace.invoke("add_reviewed_note", {
        ...f.review(),
        variableName: "alu",
        attachments: [
          {
            ...f.review().attachments[0],
            startColumn: 9,
            endColumn: 12,
            text: "alu",
          },
        ],
      }),
    /whole variable name/
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, ".codepaths/workspace.json"), "utf8"),
    before
  );
});

test("presentation updates keep revision and source conflict protection", (t) => {
  const f = fixture(t),
    original = f.workspace.invoke("add_reviewed_note", f.review()),
    review = f.review();
  f.workspace.invoke("add_note", {
    walkthroughId: f.current().id,
    stepId: "run",
    body: "Concurrent note",
    author: "User",
  });
  assert.throws(
    () =>
      f.workspace.invoke("review_note", {
        ...review,
        noteId: original.id,
        variableName: "value",
      }),
    /changed/i
  );
  const fresh = f.review();
  fs.appendFileSync(path.join(f.root, "flow.ts"), "// changed\n");
  assert.throws(
    () =>
      f.workspace.invoke("review_note", {
        ...fresh,
        noteId: original.id,
        archived: true,
      }),
    /Source changed/
  );
  assert.equal(f.current().steps[0].notes[0].archived, undefined);
});
test("maintenance retains classification and prior presentation in note history", (t) => {
  const f = fixture(t),
    note = f.workspace.invoke("add_reviewed_note", {
      ...f.review(),
      variableName: "value",
      archived: true,
    }),
    p = f.current();
  fs.writeFileSync(
    path.join(f.root, ".codepaths/pending-note-updates.json"),
    JSON.stringify({
      id: "presentation",
      updates: [
        {
          walkthroughId: p.id,
          stepId: "run",
          noteId: note.id,
          oldBody: note.body,
          oldHash: note.hash,
          newBody: "Reviewed replacement",
          sourceHash: p.steps[0].code.hash,
          author: "Maintenance",
        },
      ],
    })
  );
  f.workspace.applyPendingNoteUpdates();
  const saved = f.reopen().steps[0].notes[0];
  assert.equal(saved.variableName, "value");
  assert.equal(saved.archived, true);
  assert.equal(saved.history.at(-1).variableName, "value");
  assert.equal(saved.history.at(-1).archived, true);
});
