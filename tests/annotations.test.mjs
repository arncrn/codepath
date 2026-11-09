import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../dist/workspace.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepath-annotations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "flow.ts"),
    "export function one() {\n  const value = 1;\n  return value;\n}\nexport function two() { const value = 2; return value; }\n"
  );
  const workspace = openWorkspace(root);
  const walk = workspace.invoke("save_walkthrough", {
    title: "Fixture",
    steps: [
      {
        id: "one",
        title: "One",
        source: { file: "flow.ts", symbol: "one" },
        explanation: "Old summary",
      },
    ],
  });
  const current = () => workspace.invoke("get_walkthrough", { id: walk.id });
  const review = () => {
    const p = current();
    return {
      walkthroughId: p.id,
      stepId: "one",
      expectedRevision: p.revision,
      sourceHash: p.steps[0].code.hash,
      fileHash: p.steps[0].code.fileHash,
      author: "Reviewer",
    };
  };
  const attachment = () => ({
    file: "flow.ts",
    fileHash: current().steps[0].code.fileHash,
    startLine: 2,
    startColumn: 8,
    endLine: 2,
    endColumn: 13,
    text: "value",
  });
  return { root, workspace, current, review, attachment };
}

test("generic source replacement retains the last reviewed hash until deliberate review", (t) => {
  const f = fixture(t);
  f.workspace.invoke("review_explanation", {
    ...f.review(),
    body: "Reviewed against one",
    attachments: [],
  });
  const before = f.current();
  const reviewedHash = before.steps[0].snapshotHash;
  f.workspace.invoke("save_walkthrough", {
    ...before,
    expectedRevision: before.revision,
    steps: before.steps.map((step) => ({
      ...step,
      source: { file: "flow.ts", symbol: "two" },
    })),
  });
  const reopened = openWorkspace(f.root);
  const replaced = reopened.invoke("get_walkthrough", { id: before.id });
  const step = replaced.steps[0];
  assert.notEqual(step.code.hash, reviewedHash);
  assert.equal(
    step.snapshotHash,
    reviewedHash,
    "Source replacement is not a review of the previous explanation."
  );
  assert.equal(step.explanationReviewRequired, true);
  const reviewed = reopened.invoke("review_explanation", {
    walkthroughId: replaced.id,
    stepId: step.id,
    expectedRevision: replaced.revision,
    sourceHash: step.code.hash,
    fileHash: step.code.fileHash,
    body: "Reviewed against two",
    author: "Next reviewer",
    attachments: [],
  });
  assert.equal(reviewed.steps[0].explanationHistory.at(-1).hash, reviewedHash);
  assert.equal(
    reviewed.steps[0].explanationHistory.at(-1).body,
    "Reviewed against one"
  );
});

test("deliberate corrections retain IDs and prior authorship, reject stale reviews and persist many-to-many ranges", (t) => {
  const f = fixture(t);
  const original = f.workspace.invoke("add_note", {
    walkthroughId: f.current().id,
    stepId: "one",
    body: "Old detail",
    author: "Original",
  });
  const reviewed = f.review();
  const updated = f.workspace.invoke("review_note", {
    ...reviewed,
    noteId: original.id,
    body: "Correct detail",
    attachments: [
      f.attachment(),
      {
        ...f.attachment(),
        startLine: 3,
        startColumn: 9,
        endLine: 3,
        endColumn: 14,
      },
    ],
  });
  assert.equal(updated.id, original.id);
  assert.deepEqual(updated.history[0], {
    body: original.body,
    author: original.author,
    at: original.at,
    hash: original.hash,
  });
  assert.equal(updated.attachments.length, 2);
  assert.throws(
    () =>
      f.workspace.invoke("review_note", {
        ...reviewed,
        noteId: original.id,
        body: "Lost edit",
        attachments: [],
      }),
    /changed/
  );
  f.workspace.invoke("add_reviewed_note", {
    ...f.review(),
    body: "Second explanation",
    attachments: [f.attachment()],
  });
  const saved = openWorkspace(f.root).invoke("get_walkthrough", {
    id: f.current().id,
  });
  assert.equal(saved.steps[0].notes.length, 2);
  assert.equal(saved.steps[0].notes[0].attachments[0].startColumn, 8);
  fs.appendFileSync(path.join(f.root, "flow.ts"), "// changed elsewhere\n");
  assert.throws(
    () =>
      f.workspace.invoke("review_note", {
        ...f.review(),
        fileHash: reviewed.fileHash,
        noteId: original.id,
        body: "Unread",
        attachments: [],
      }),
    /Source changed/
  );
});

test("bad ranges, text, source versions and persisted attachments fail closed", (t) => {
  const f = fixture(t);
  for (const bad of [
    { startColumn: -1 },
    { endColumn: 999 },
    { text: "other" },
    { fileHash: "old" },
    { file: "../outside.ts" },
    { startLine: 5, endLine: 5 },
  ]) {
    assert.throws(() =>
      f.workspace.invoke("add_reviewed_note", {
        ...f.review(),
        body: "Detail",
        attachments: [{ ...f.attachment(), ...bad }],
      })
    );
  }
  assert.equal(f.current().steps[0].notes.length, 0);
  const metadata = path.join(f.root, ".codepaths/workspace.json");
  const state = JSON.parse(fs.readFileSync(metadata, "utf8"));
  state.paths[0].steps[0].explanationAttachments = [
    { file: "flow.ts", startColumn: "bad" },
  ];
  fs.writeFileSync(metadata, JSON.stringify(state));
  assert.throws(() => openWorkspace(f.root), /attachment/);
});

test("source repair preserves unread explanation and note history until separate re-review", (t) => {
  const f = fixture(t);
  const note = f.workspace.invoke("add_note", {
    walkthroughId: f.current().id,
    stepId: "one",
    body: "Old detail",
    author: "Original",
  });
  const before = f.current();
  fs.writeFileSync(
    path.join(f.root, "flow.ts"),
    "export function replacement() { return 3; }\n"
  );
  assert.ok(f.current().steps[0].error);
  const fileHash = f.workspace.invoke("read_source", {
    file: "flow.ts",
  }).fileHash;
  const repaired = f.workspace.invoke("repair_step_source", {
    walkthroughId: before.id,
    stepId: "one",
    expectedRevision: before.revision,
    source: { file: "flow.ts", symbol: "replacement" },
    fileHash,
  });
  assert.equal(repaired.steps[0].id, "one");
  assert.equal(repaired.steps[0].snapshotHash, before.steps[0].snapshotHash);
  assert.equal(repaired.steps[0].stale, true);
  assert.equal(repaired.steps[0].notes[0].stale, true);
  assert.deepEqual(repaired.steps[0].notes[0].hash, note.hash);
  const reviewed = f.workspace.invoke("review_explanation", {
    ...f.review(),
    body: "Reviewed summary",
    attachments: [],
  });
  assert.equal(reviewed.steps[0].stale, false);
  assert.equal(reviewed.steps[0].notes[0].stale, true);
  assert.equal(reviewed.steps[0].explanationHistory[0].body, "Old summary");
  f.workspace.invoke("review_note", {
    ...f.review(),
    noteId: note.id,
    body: note.body,
    attachments: [],
  });
  assert.equal(f.current().steps[0].notes[0].stale, false);
});

test("unchanged unique source context safely relocates attachments, changed context stays flagged", (t) => {
  const f = fixture(t);
  f.workspace.invoke("add_reviewed_note", {
    ...f.review(),
    body: "Variable role",
    attachments: [f.attachment()],
  });
  const original = f.current().steps[0].notes[0].attachments[0];
  const source = fs.readFileSync(path.join(f.root, "flow.ts"), "utf8");
  fs.writeFileSync(path.join(f.root, "flow.ts"), "// moved\n" + source);
  const moved = f.current().steps[0].notes[0];
  assert.equal(moved.stale, false);
  assert.equal(moved.attachments[0].startLine, 3);
  assert.notEqual(moved.attachments[0].fileHash, original.fileHash);
  fs.writeFileSync(
    path.join(f.root, "flow.ts"),
    source.replace("value = 1", "value = 4")
  );
  const changed = f.current().steps[0].notes[0];
  assert.equal(changed.stale, true);
  assert.equal(changed.attachments[0].fileHash, original.fileHash);
});

test("correction history retains authored attachments and exact multiline selections", (t) => {
  const f = fixture(t);
  const attachment = {
    ...f.attachment(),
    startColumn: 2,
    endLine: 3,
    endColumn: 14,
    text: "const value = 1;\n  return value",
  };
  const original = f.workspace.invoke("add_reviewed_note", {
    ...f.review(),
    body: "Block explanation",
    attachments: [attachment],
  });
  const updated = f.workspace.invoke("review_note", {
    ...f.review(),
    noteId: original.id,
    body: "Correct block explanation",
    attachments: [],
  });
  assert.deepEqual(updated.history[0].attachments, original.attachments);
  assert.equal(updated.history[0].at, original.at);
  assert.equal(updated.id, original.id);
  assert.deepEqual(updated.attachments, []);
});

test("failed annotation persistence rolls back revisions, bodies and history", (t) => {
  const f = fixture(t);
  const original = f.workspace.invoke("add_note", {
    walkthroughId: f.current().id,
    stepId: "one",
    body: "Original",
    author: "Original author",
  });
  const before = f.current(),
    overview = f.workspace.overview();
  const file = path.join(f.root, ".codepaths/workspace.json");
  const disk = fs.readFileSync(file, "utf8");
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() =>
    f.workspace.invoke("review_note", {
      ...f.review(),
      noteId: original.id,
      body: "Never saved",
      attachments: [],
    })
  );
  assert.deepEqual(f.current(), before);
  assert.equal(f.workspace.overview().revision, overview.revision);
  fs.rmdirSync(file);
  fs.writeFileSync(file, disk);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        openWorkspace(f.root).invoke("get_walkthrough", { id: before.id })
      )
    ),
    JSON.parse(JSON.stringify(before))
  );
});

test("ambiguous context never relocates an attachment onto a same-text occurrence", (t) => {
  const f = fixture(t);
  const before = f.current();
  f.workspace.invoke("save_walkthrough", {
    id: before.id,
    title: before.title,
    expectedRevision: before.revision,
    steps: [
      {
        ...before.steps[0],
        source: { file: "flow.ts", startLine: 1, endLine: 4 },
      },
    ],
  });
  const note = f.workspace.invoke("add_reviewed_note", {
    ...f.review(),
    body: "Only this occurrence",
    attachments: [f.attachment()],
  });
  const content = fs.readFileSync(path.join(f.root, "flow.ts"), "utf8");
  fs.writeFileSync(
    path.join(f.root, "flow.ts"),
    content + content.split("\n").slice(0, 4).join("\n") + "\n"
  );
  const current = f.current().steps[0];
  assert.notEqual(current.code.fileHash, note.attachments[0].fileHash);
  assert.equal(
    current.notes[0].attachments[0].fileHash,
    note.attachments[0].fileHash,
    "unresolved positional attachment stays flagged by its old version"
  );
});

test("source replacement with an external symlink is rejected without changing note data", (t) => {
  const f = fixture(t),
    outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "codepath-annotation-outside-")
    );
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const review = f.review();
  fs.writeFileSync(
    path.join(outside, "external.ts"),
    "export const secret = 1;\n"
  );
  fs.unlinkSync(path.join(f.root, "flow.ts"));
  fs.symlinkSync(
    path.join(outside, "external.ts"),
    path.join(f.root, "flow.ts")
  );
  assert.throws(
    () =>
      f.workspace.invoke("add_reviewed_note", {
        ...review,
        body: "Forbidden read",
        attachments: [],
      }),
    /not indexed/
  );
  assert.equal(f.current().steps[0].notes.length, 0);
});

test("generic body edits preserve acknowledged history without borrowing reviewer attribution", (t) => {
  const f = fixture(t);
  f.workspace.invoke("add_reviewed_note", {
    ...f.review(),
    body: "An independently reviewed note",
    attachments: [f.attachment()],
  });
  f.workspace.invoke("review_explanation", {
    ...f.review(),
    body: "Reviewed",
    attachments: [f.attachment()],
    author: "Reviewer A",
  });
  const before = f.current(),
    acknowledged = before.steps[0];
  f.workspace.invoke("save_walkthrough", {
    ...before,
    expectedRevision: before.revision,
    steps: [{ ...acknowledged, explanation: "Unreviewed replacement" }],
  });
  let reopened = openWorkspace(f.root);
  let saved = reopened.invoke("get_walkthrough", { id: before.id });
  const edited = saved.steps[0];
  assert.deepEqual(
    edited.explanationHistory.at(-1),
    {
      body: "Reviewed",
      author: "Reviewer A",
      at: acknowledged.explanationAt,
      hash: acknowledged.snapshotHash,
      attachments: acknowledged.explanationAttachments,
    },
    "the acknowledged version remains available after generic overwrite and reopen"
  );
  assert.equal(
    edited.explanationHistory.length,
    acknowledged.explanationHistory.length + 1
  );
  assert.equal(edited.explanation, "Unreviewed replacement");
  assert.equal(edited.explanationAuthor, undefined);
  assert.equal(edited.explanationAt, undefined);
  assert.equal(edited.explanationAttachments, undefined);
  assert.equal(edited.snapshotHash, acknowledged.snapshotHash);
  assert.equal(edited.explanationReviewRequired, true);
  assert.equal(edited.stale, true);
  assert.deepEqual(
    edited.notes,
    acknowledged.notes,
    "a body-only card edit cannot invalidate independently reviewed notes"
  );
  reopened.invoke("save_walkthrough", {
    ...saved,
    expectedRevision: saved.revision,
  });
  saved = openWorkspace(f.root).invoke("get_walkthrough", { id: before.id });
  assert.deepEqual(
    saved.steps[0],
    edited,
    "unchanged saves do not duplicate history or clear required review"
  );
  reopened = openWorkspace(f.root);
  reopened.invoke("review_explanation", {
    walkthroughId: saved.id,
    stepId: "one",
    expectedRevision: saved.revision,
    sourceHash: edited.code.hash,
    fileHash: edited.code.fileHash,
    body: edited.explanation,
    author: "Reviewer B",
    attachments: [],
  });
  const reviewed = openWorkspace(f.root).invoke("get_walkthrough", {
    id: before.id,
  }).steps[0];
  assert.equal(reviewed.explanationReviewRequired, false);
  assert.equal(reviewed.stale, false);
  assert.equal(reviewed.explanationAuthor, "Reviewer B");
  assert.equal(
    reviewed.explanationHistory.at(-1).author,
    "Unknown original author"
  );
});

test("generic unchanged body, title, order and incidental metadata preserve reviews, anchors and run data", (t) => {
  const f = fixture(t);
  let p = f.current();
  f.workspace.invoke("save_walkthrough", {
    ...p,
    expectedRevision: p.revision,
    steps: [
      {
        ...p.steps[0],
        callbackRole: "registration",
        sample: { input: { value: 1 } },
      },
      {
        id: "two",
        title: "Two",
        explanation: "Second",
        source: { file: "flow.ts", symbol: "two" },
      },
    ],
  });
  f.workspace.invoke("review_explanation", {
    ...f.review(),
    body: "Reviewed",
    attachments: [f.attachment()],
  });
  f.workspace.invoke("add_reviewed_note", {
    ...f.review(),
    body: "Reviewed note",
    attachments: [f.attachment()],
  });
  const run = f.workspace.invoke("record_run", {
    walkthroughId: p.id,
    mode: "example",
    origin: "test fixture",
    label: "Saved run",
    events: [
      {
        stepId: "one",
        sourceHash: f.current().steps[0].code.hash,
        input: { value: 1 },
        output: { value: 2 },
      },
    ],
  });
  p = f.current();
  const before = p.steps[0];
  f.workspace.invoke("save_walkthrough", {
    ...p,
    title: "Renamed path",
    expectedRevision: p.revision,
    steps: [...p.steps].reverse().map((s) => ({
      ...s,
      title: s.title + " renamed",
      clientHint: "fixture-only",
    })),
  });
  const reopened = openWorkspace(f.root),
    saved = reopened.invoke("get_walkthrough", { id: p.id });
  assert.deepEqual(
    saved.steps.map((s) => s.id),
    ["two", "one"]
  );
  const after = saved.steps[1];
  assert.deepEqual({ ...after, title: before.title }, before);
  assert.equal(after.explanationReviewRequired, false);
  assert.equal(after.stale, false);
  assert.deepEqual(reopened.invoke("get_run", { id: run.id }), run);
});

for (const replacement of ["file", "range"]) {
  test(
    "generic equal-content source " +
      replacement +
      " replacement requires independent review after reopen",
    (t) => {
      const f = fixture(t);
      const content = fs.readFileSync(path.join(f.root, "flow.ts"), "utf8");
      fs.writeFileSync(path.join(f.root, "copy.ts"), content);
      fs.appendFileSync(
        path.join(f.root, "flow.ts"),
        content.split("\n").slice(0, 4).join("\n") + "\n"
      );
      let p = f.current();
      f.workspace.invoke("save_walkthrough", {
        ...p,
        expectedRevision: p.revision,
        steps: [
          {
            ...p.steps[0],
            source: { file: "flow.ts", startLine: 1, endLine: 4 },
          },
        ],
      });
      f.workspace.invoke("review_explanation", {
        ...f.review(),
        body: "Reviewed",
        attachments: [f.attachment()],
      });
      const note = f.workspace.invoke("add_reviewed_note", {
        ...f.review(),
        body: "Reviewed note",
        attachments: [f.attachment()],
      });
      f.workspace.invoke("review_note", {
        ...f.review(),
        noteId: note.id,
        body: note.body,
        attachments: [f.attachment()],
      });
      p = f.current();
      const before = p.steps[0];
      f.workspace.invoke("save_walkthrough", {
        ...p,
        expectedRevision: p.revision,
        steps: [
          {
            ...before,
            source:
              replacement === "file"
                ? { file: "copy.ts", startLine: 1, endLine: 4 }
                : { file: "flow.ts", startLine: 6, endLine: 9 },
          },
        ],
      });
      let reopened = openWorkspace(f.root),
        saved = reopened.invoke("get_walkthrough", { id: p.id });
      const repaired = saved.steps[0];
      assert.equal(
        repaired.code.hash,
        before.code.hash,
        "fixture replaces source identity without changing excerpt contents"
      );
      assert.equal(repaired.explanationReviewRequired, true);
      assert.equal(repaired.stale, true);
      assert.equal(repaired.notes[0].reviewRequired, true);
      assert.equal(repaired.notes[0].stale, true);
      assert.deepEqual(repaired.explanationHistory, before.explanationHistory);
      assert.deepEqual(
        repaired.explanationAttachments,
        before.explanationAttachments
      );
      assert.deepEqual(
        { ...repaired.notes[0], reviewRequired: false, stale: false },
        before.notes[0]
      );
      reopened.invoke("save_walkthrough", {
        ...saved,
        expectedRevision: saved.revision,
        steps: [{ ...repaired, title: "Metadata-only save" }],
      });
      reopened = openWorkspace(f.root);
      saved = reopened.invoke("get_walkthrough", { id: p.id });
      assert.equal(saved.steps[0].explanationReviewRequired, true);
      assert.equal(saved.steps[0].notes[0].reviewRequired, true);
      reopened.invoke("review_explanation", {
        walkthroughId: saved.id,
        stepId: "one",
        expectedRevision: saved.revision,
        sourceHash: repaired.code.hash,
        fileHash: repaired.code.fileHash,
        body: repaired.explanation,
        author: "Reviewer B",
        attachments: [],
      });
      const reviewed = openWorkspace(f.root).invoke("get_walkthrough", {
        id: p.id,
      }).steps[0];
      assert.equal(reviewed.stale, false);
      assert.equal(
        reviewed.notes[0].stale,
        true,
        "reviewing the card cannot review its old notes"
      );
    }
  );
}
