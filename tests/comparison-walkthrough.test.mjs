import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

function authoredSide(title, purpose, value = "amount") {
  return {
    title,
    purpose,
    startLine: 1,
    endLine: 1,
    notes: [{ body: title + " block", startLine: 1, endLine: 1 }],
    variables: [
      {
        name: value,
        body: title + " variable",
        occurrences: [{ line: 1, startColumn: 6 }],
      },
    ],
  };
}

test("An agent authors paired walkthrough steps from admitted Git versions, not caller source or file order", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 7;\nunchanged\n");
  const list = await allChanges(f.service);
  const file = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    [],
    "Git source reads never synthesize or persist authored steps"
  );
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Amount behavior",
    listId: list.listId,
    steps: ["read", "return"].map((id) => ({
      id,
      title: id,
      fileId: file.id,
      binding: view.binding,
      before: authoredSide("Earlier " + id, "Use the former value"),
      after: authoredSide("Revised " + id, "Use seven instead"),
    })),
  });
  assert.equal(saved.steps.length, 2);
  assert.deepEqual(saved.query, { mode: "changes" });
  assert.equal(saved.steps[0].before.purpose, "Use the former value");
  assert.equal(saved.steps[0].after.purpose, "Use seven instead");
  assert.equal(saved.steps[0].before.code.excerpt, "const amount = 1;");
  assert.equal(saved.steps[0].after.code.excerpt, "const amount = 7;");
  assert.notEqual(
    saved.steps[0].annotations.scope,
    saved.steps[1].annotations.scope
  );
  assert.equal(
    saved.steps[0].annotations.notes.filter((n) => n.side === "before").length,
    2
  );
  assert.equal(
    saved.steps[0].annotations.notes.find((n) => n.variableName)?.attachments[0]
      .text,
    "amount"
  );
  await f.reopen();
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  const revision = (await f.service.call("project_overview", {})).revision;
  assert.deepEqual(await f.service.call("list_comparison_walkthroughs", {}), [
    { id: saved.id, title: "Amount behavior", count: 2 },
  ]);
  await f.service.call("get_comparison_walkthrough", { id: saved.id });
  assert.equal(
    (await f.service.call("project_overview", {})).revision,
    revision,
    "Reading authored sources never stamps/rebinds/migrates state"
  );
});

test("Human annotations remain card/side scoped, revision guarded, persistent and historical; opposite-side source movement rejects writes", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 7;\nunchanged\n");
  const ordinary = await f.service.call("save_walkthrough", {
    title: "Ordinary",
    steps: [
      {
        id: "live",
        title: "Live",
        source: { file: "part.ts", startLine: 1, endLine: 1 },
        explanation: "Ordinary purpose",
      },
    ],
  });
  const baseline = await f.service.call("get_walkthrough", { id: ordinary.id });
  const legacy = await f.service.call("create_change_review", {
    title: "Legacy immutable record",
    cards: [
      {
        id: "legacy",
        title: "Legacy",
        beforeBehavior: "Former value",
        afterBehavior: "Saved value",
        reason: "Historical explanation",
        before: {
          ...authoredSide("Legacy before", "Legacy former purpose"),
          file: "part.ts",
          content: "const amount = 1;\nunchanged\n",
          provenance: "Explicit legacy fixture",
        },
        after: {
          ...authoredSide("Legacy after", "Legacy current purpose"),
          file: "part.ts",
          content: "const amount = 7;\nunchanged\n",
          provenance: "Explicit legacy fixture",
        },
      },
    ],
  });
  const list = await allChanges(f.service);
  const file = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const fileNotes = await f.service.call("save_comparison_note", {
    listId: list.listId,
    fileId: file.id,
    binding: view.binding,
    side: "before",
    expectedRevision: 0,
    body: "Old file annotation",
    author: "Human",
    attachments: [],
  });
  const input = {
    title: "Scoped",
    listId: list.listId,
    steps: ["a", "b"].map((id) => ({
      id,
      title: id,
      fileId: file.id,
      binding: view.binding,
      before: authoredSide("Before " + id, "Former behavior"),
      after: authoredSide("After " + id, "New behavior"),
    })),
  };
  const saved = await f.service.call("create_comparison_walkthrough", input);
  // Reopen destroys every ephemeral Git list. Editing needs no human session setup.
  await f.reopen();
  const a = saved.steps[0];
  const arg = {
    walkthroughId: saved.id,
    stepId: "a",
    side: "before",
    binding: a.binding,
    expectedRevision: a.annotations.revision,
    body: "New human block",
    author: "Human",
    attachments: [a.annotations.notes[0].attachments[0]],
  };
  let group = await f.service.call("save_walkthrough_comparison_note", arg);
  const note = group.notes.at(-1);
  await assert.rejects(
    f.service.call("save_walkthrough_comparison_note", arg),
    /revision|changed/i
  );
  group = await f.service.call("save_walkthrough_comparison_note", {
    ...arg,
    noteId: note.id,
    expectedRevision: group.revision,
    body: "Edited human block",
  });
  assert.equal(group.notes.at(-1).id, note.id);
  assert.equal(group.notes.at(-1).history[0].body, "New human block");
  const read = await f.service.call("get_comparison_walkthrough", {
    id: saved.id,
  });
  assert.equal(
    read.steps[1].annotations.notes.length,
    4,
    "Repeated source never shares card notes"
  );
  await assert.rejects(
    f.service.call("save_walkthrough_comparison_note", {
      ...arg,
      stepId: "b",
      expectedRevision: saved.steps[1].annotations.revision,
      noteId: note.id,
    }),
    /different|found/i
  );
  f.write("part.ts", "const amount = 8;\nunchanged\n");
  await assert.rejects(
    f.service.call("save_walkthrough_comparison_note", {
      ...arg,
      expectedRevision: group.revision,
      noteId: note.id,
    }),
    /changed|binding/i
  );
  assert.equal(
    (await f.service.call("get_comparison_walkthrough", { id: saved.id }))
      .steps[0].after.code.excerpt,
    "const amount = 7;",
    "Read retains honest authored versions"
  );
  const deletion = {
    walkthroughId: saved.id,
    stepId: "a",
    scope: group.scope,
    noteId: note.id,
    expectedRevision: group.revision,
  };
  const temp = path.join(
    f.root,
    `.codepaths/workspace.json.${process.pid}.tmp`
  );
  fs.mkdirSync(temp);
  await assert.rejects(
    f.service.call("delete_walkthrough_comparison_note", deletion),
    /EISDIR/
  );
  fs.rmdirSync(temp);
  group = await f.service.call("delete_walkthrough_comparison_note", deletion);
  assert.equal(group.notes.at(-1).archived, true);
  assert.equal(group.notes.at(-1).history.length, 2);
  await f.reopen();
  assert.deepEqual(
    (await f.service.call("get_comparison_walkthrough", { id: saved.id }))
      .steps[0].annotations,
    group
  );
  const preserved = await f.service.call("get_walkthrough", {
    id: ordinary.id,
  });
  assert.equal(preserved.revision, baseline.revision);
  assert.equal(preserved.steps[0].explanation, baseline.steps[0].explanation);
  assert.equal(preserved.steps[0].snapshotHash, baseline.steps[0].snapshotHash);
  assert.deepEqual(preserved.steps[0].notes, baseline.steps[0].notes);
  assert.equal(
    preserved.steps[0].stale,
    true,
    "Ordinary source safety still reports changed live code"
  );
  const refreshed = await allChanges(f.service);
  const current = await f.service.call("get_git_file", {
    listId: refreshed.listId,
    fileId: file.id,
  });
  assert.equal(current.annotations.notes[0].id, fileNotes.notes[0].id);
  assert.equal(current.annotations.notes[0].body, "Old file annotation");
  const preservedLegacy = await f.service.call("get_change_review", {
    id: legacy.id,
  });
  assert.equal(preservedLegacy.fingerprint, legacy.fingerprint);
  assert.deepEqual(preservedLegacy.cards, legacy.cards);
});

test("Committed renames, additions, deletions, empty sources and identical context are authored honestly without an eight-pair cap", async (t) => {
  const f = await gitProject(t);
  f.write("doomed.ts", "const amount = 6;\n");
  f.git("add", "--", "doomed.ts");
  f.git("commit", "--quiet", "-m", "before deletion");
  f.git("branch", "before");
  f.git("mv", "--", "part.ts", "renamed.ts");
  f.git("rm", "--", "doomed.ts");
  f.write("fresh.ts", "const amount = 9;\n");
  f.write("empty.ts", "");
  f.git("add", "--", "fresh.ts", "empty.ts");
  f.git("commit", "--quiet", "-m", "rename add delete empty");
  const query = { mode: "compare", base: "refs/heads/before", target: "HEAD" };
  const list = await allChanges(f.service, query);
  const steps = [];
  const absent = (title) => ({
    title,
    purpose: "Explain the genuine absence or empty file on this side.",
    startLine: 0,
    endLine: 0,
    notes: [],
    variables: [],
    notApplicable: {
      notes: "There are no source blocks in this exact empty side.",
      variables: "There are no identifiers in this exact empty side.",
    },
  });
  for (const file of list.files) {
    const view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
    steps.push({
      id: "pair-" + steps.length,
      title: file.status,
      fileId: file.id,
      binding: view.binding,
      before:
        view.before.content === ""
          ? absent("Before absence")
          : authoredSide("Before purpose", "Explain the earlier source."),
      after:
        view.after.content === ""
          ? absent("After absence")
          : authoredSide("After purpose", "Explain the resulting source."),
    });
  }
  const renamed = steps.find((step) => step.title === "renamed");
  assert.ok(renamed, "Actual exact-content rename is provided by Git");
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Real committed changes",
    listId: list.listId,
    steps,
  });
  assert.deepEqual(saved.query, query);
  const move = saved.steps.find((step) => step.title === "renamed");
  assert.equal(move.before.file, "part.ts");
  assert.equal(move.after.file, "renamed.ts");
  assert.equal(
    move.before.code.excerpt,
    move.after.code.excerpt,
    "Unchanged renamed source is not forced into a fake difference"
  );
  const deletion = saved.steps.find((step) => step.title === "deleted");
  assert.equal(deletion.after.mode, "000000");
  assert.equal(deletion.after.code.excerpt, "");
  const empty = saved.steps.find((step) => step.after.file === "empty.ts");
  assert.equal(empty.after.mode, "100644");
  assert.equal(empty.after.code.startLine, 0);
  await f.reopen();
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
  // Same context inside a genuinely changed file is allowed, not arbitrary unlisted files.
  f.write("renamed.ts", "const amount = 10;\nunchanged\n");
  const dirty = await allChanges(f.service, {
    mode: "compare",
    base: "HEAD",
    target: "WORKING_TREE",
  });
  const file = dirty.files.find((file) => file.file === "renamed.ts");
  const view = await f.service.call("get_git_file", {
    listId: dirty.listId,
    fileId: file.id,
  });
  const context = (title) => ({
    title,
    purpose: title + " unchanged context purpose",
    startLine: 2,
    endLine: 2,
    notes: [{ body: title + " context block", startLine: 2, endLine: 2 }],
    variables: [
      {
        name: "unchanged",
        body: title + " explicitly classified identifier",
        occurrences: [{ line: 2, startColumn: 0 }],
      },
    ],
  });
  const nine = await f.service.call("create_comparison_walkthrough", {
    title: "Nine authored context steps",
    listId: dirty.listId,
    steps: Array.from({ length: 9 }, (_, i) => ({
      id: "context-" + i,
      title: "Context " + i,
      fileId: file.id,
      binding: view.binding,
      before: context("Before " + i),
      after: context("After " + i),
    })),
  });
  assert.equal(nine.steps.length, 9);
  assert.equal(nine.steps[8].before.code.excerpt, "unchanged");
  assert.equal(nine.steps[8].after.code.excerpt, "unchanged");
});

test("Authoring rejects forged sources, invalid exact ranges/identifiers, unavailable normalization and oversize input without creating records", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 7;\nunchanged\n");
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const step = {
    id: "one",
    title: "One",
    fileId: file.id,
    binding: view.binding,
    before: authoredSide("Before", "Former behavior"),
    after: authoredSide("After", "Changed behavior"),
  };
  const input = { title: "Must not save", listId: list.listId, steps: [step] };
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", {
      ...input,
      listId: "expired",
      steps: [{ ...step, after: { ...step.after, content: "forged source" } }],
    }),
    /Unexpected.*source/i
  );
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", {
      ...input,
      steps: [{ ...step, after: { ...step.after, endLine: 500 } }],
    }),
    /400 lines|range/i
  );
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", {
      ...input,
      steps: [
        {
          ...step,
          after: {
            ...step.after,
            variables: [
              {
                name: "mount",
                body: "Partial identifier",
                occurrences: [{ line: 1, startColumn: 7 }],
              },
            ],
          },
        },
      ],
    }),
    /identifier/i
  );
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", {
      ...input,
      steps: [{ ...step, after: { ...step.after, notes: [] } }],
    }),
    /notApplicable/i
  );
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", {
      ...input,
      title: "x".repeat(1024 * 1024),
    }),
    /1 MiB/
  );
  const marker = path.join(f.root, "must-not-execute");
  f.git("config", "filter.unsafe.clean", `touch '${marker}'`);
  f.git("config", "filter.unsafe.smudge", `touch '${marker}'`);
  f.write(".gitattributes", "part.ts filter=unsafe\n");
  const unavailable = await allChanges(f.service),
    unknown = unavailable.files.find((file) => file.file === "part.ts");
  const unsupported = await f.service.call("get_git_file", {
    listId: unavailable.listId,
    fileId: unknown.id,
  });
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", {
      ...input,
      listId: unavailable.listId,
      steps: [{ ...step, fileId: unknown.id, binding: unsupported.binding }],
    }),
    /unavailable/i
  );
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
  assert.equal((await f.service.call("project_overview", {})).revision, 0);
});

test("Async authoring commits against current workspace state and owner closure cannot publish a deferred walkthrough", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 7;\nunchanged\n");
  const ordinary = await f.service.call("save_walkthrough", {
    title: "Concurrent ordinary",
    steps: [
      {
        id: "live",
        title: "Live",
        source: { file: "part.ts", startLine: 1, endLine: 1 },
      },
    ],
  });
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "part.ts"),
    view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
  const input = {
    title: "Concurrent authored",
    listId: list.listId,
    steps: [
      {
        id: "one",
        title: "One",
        fileId: file.id,
        binding: view.binding,
        before: authoredSide("Before", "Former behavior"),
        after: authoredSide("After", "Changed behavior"),
      },
    ],
  };
  const pending = f.service.call("create_comparison_walkthrough", input);
  await delay(10);
  await f.service.call("add_note", {
    walkthroughId: ordinary.id,
    stepId: "live",
    body: "Keep concurrent ordinary mutation",
    author: "Human",
  });
  const saved = await pending;
  assert.equal(
    (await f.service.call("get_walkthrough", { id: ordinary.id })).steps[0]
      .notes[0].body,
    "Keep concurrent ordinary mutation"
  );
  assert.equal(
    (await f.service.call("get_comparison_walkthrough", { id: saved.id })).steps
      .length,
    1
  );
  // A second actual async request is cancelled/drained before ownership release.
  let settled = false;
  const closing = f.service
    .call("create_comparison_walkthrough", {
      ...input,
      title: "Must not survive close",
    })
    .finally(() => {
      settled = true;
    });
  const refused = assert.rejects(closing);
  await delay(10);
  assert.equal(settled, false);
  await f.service.close();
  await refused;
  await f.reopen();
  assert.deepEqual(
    (await f.service.call("list_comparison_walkthroughs", {})).map(
      (w) => w.title
    ),
    ["Concurrent authored"]
  );
  assert.equal(
    (await f.service.call("get_walkthrough", { id: ordinary.id })).steps[0]
      .notes[0].body,
    "Keep concurrent ordinary mutation"
  );
});

test("Prospective saved budgets retain complete history, safe refusal, deletion headroom and reopenability", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 7; // " + "x".repeat(50000) + "\n");
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "part.ts"),
    view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
  const after = authoredSide(
    "Large after",
    "Explain a large exact source block"
  );
  after.notes = Array.from({ length: 14 }, (_, i) => ({
    body: "Explicit block " + i,
    startLine: 1,
    endLine: 1,
  }));
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", {
      title: "Oversized authored snapshot",
      listId: list.listId,
      steps: [
        {
          id: "too-large",
          title: "Too large",
          fileId: file.id,
          binding: view.binding,
          before: authoredSide("Before", "Former purpose"),
          after: {
            ...after,
            notes: Array.from({ length: 42 }, (_, i) => ({
              body: "Explicit block " + i,
              startLine: 1,
              endLine: 1,
            })),
          },
        },
      ],
    }),
    /2 MiB/
  );
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Bounded persisted notes",
    listId: list.listId,
    steps: [
      {
        id: "one",
        title: "One",
        fileId: file.id,
        binding: view.binding,
        before: authoredSide("Before", "Former purpose"),
        after,
      },
    ],
  });
  let group = saved.steps[0].annotations,
    noteId;
  let accepted = 0,
    refused = false;
  for (let i = 0; i < 180; i++) {
    const previous = group;
    try {
      group = await f.service.call("save_walkthrough_comparison_note", {
        walkthroughId: saved.id,
        stepId: "one",
        side: "after",
        binding: saved.steps[0].binding,
        expectedRevision: group.revision,
        ...(noteId ? { noteId } : {}),
        body: "Human " + i + " " + "a".repeat(9900),
        author: "Human",
        attachments: [],
      });
      noteId = group.notes.at(-1).id;
      accepted++;
    } catch (error) {
      assert.match(error.message, /2 MiB/);
      refused = true;
      assert.deepEqual(
        (await f.service.call("get_comparison_walkthrough", { id: saved.id }))
          .steps[0].annotations,
        previous
      );
      break;
    }
  }
  assert.equal(
    refused,
    true,
    "Repeated 9KB+ edits must hit the saved budget before commitment"
  );
  assert.equal(group.notes.at(-1).history.length, accepted - 1);
  const refusedRevision = (await f.service.call("project_overview", {}))
    .revision;
  await assert.rejects(
    f.service.call("save_walkthrough_comparison_note", {
      walkthroughId: saved.id,
      stepId: "one",
      side: "after",
      binding: saved.steps[0].binding,
      expectedRevision: group.revision,
      noteId,
      body: "x".repeat(9900),
      author: "Human",
      attachments: [],
    }),
    /2 MiB/
  );
  assert.equal(
    (await f.service.call("project_overview", {})).revision,
    refusedRevision
  );
  assert.deepEqual(
    (await f.service.call("get_comparison_walkthrough", { id: saved.id }))
      .steps[0].annotations,
    group
  );
  await f.reopen();
  assert.deepEqual(
    (await f.service.call("get_comparison_walkthrough", { id: saved.id }))
      .steps[0].annotations,
    group
  );
});

test("Deletion can archive every active version at the saved budget without losing history", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 7;\nunchanged\n");
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Archive capacity",
    listId: list.listId,
    steps: [
      {
        id: "one",
        title: "One",
        fileId: file.id,
        binding: view.binding,
        before: authoredSide("Before", "Before purpose"),
        after: authoredSide("After", "After purpose"),
      },
    ],
  });
  let group = saved.steps[0].annotations;
  let rejected = false;
  for (let i = 0; i < 150; i++) {
    try {
      group = await f.service.call("save_walkthrough_comparison_note", {
        walkthroughId: saved.id,
        stepId: "one",
        side: "after",
        binding: view.binding,
        expectedRevision: group.revision,
        body: "n".repeat(9000),
        author: "Human",
        attachments: [],
      });
    } catch (error) {
      assert.match(error.message, /2 MiB/);
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true);
  const ids = group.notes.map((n) => n.id);
  f.write("part.ts", "const amount = 99;\n");
  for (const note of group.notes) {
    const oldHistory = note.history?.length ?? 0;
    group = await f.service.call("delete_walkthrough_comparison_note", {
      walkthroughId: saved.id,
      stepId: "one",
      scope: group.scope,
      noteId: note.id,
      expectedRevision: group.revision,
    });
    const archived = group.notes.find((n) => n.id === note.id);
    assert.equal(archived.archived, true);
    assert.equal(archived.history.length, oldHistory + 1);
    assert.equal(archived.history.at(-1).body, note.body);
  }
  assert.deepEqual(
    group.notes.map((n) => n.id),
    ids
  );
  await f.reopen();
  assert.deepEqual(
    (await f.service.call("get_comparison_walkthrough", { id: saved.id }))
      .steps[0].annotations,
    group
  );
});

test("Closed-fixture immutable source corruption is refused rather than blessed on reopen", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 7;\nunchanged\n");
  const list = await allChanges(f.service);
  const file = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Integrity",
    listId: list.listId,
    steps: [
      {
        id: "one",
        title: "One",
        fileId: file.id,
        binding: view.binding,
        before: authoredSide("Before", "Former purpose"),
        after: authoredSide("After", "New purpose"),
      },
    ],
  });
  await f.service.close();
  const target = path.join(f.root, ".codepaths/workspace.json");
  const original = fs.readFileSync(target, "utf8");
  for (const corrupt of [
    (walk) => {
      walk.sources[file.id].before.code.lines[0] = "const amount = 777;";
    },
    (walk) => {
      walk.steps[0].before.purpose = "Invented purpose";
    },
    (walk) => {
      walk.steps[0].binding = "a".repeat(64);
    },
    (walk) => {
      delete walk.sourceSeal;
    },
  ]) {
    const state = JSON.parse(original);
    corrupt(state.comparisonWalkthroughs[0]);
    fs.writeFileSync(target, JSON.stringify(state));
    await assert.rejects(f.reopen(), /integrity|seal|binding/i);
    assert.equal(
      fs.readFileSync(target, "utf8"),
      JSON.stringify(state),
      "A read must not stamp or repair corrupt data"
    );
  }
  fs.writeFileSync(target, original);
  await f.reopen();
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
});

test("Repeated small steps cannot amplify a deduplicated source into an unbounded public view", async (t) => {
  const f = await gitProject(t);
  const name = "large.ts";
  f.write(name, "const amount = 1;\n//" + "x".repeat(90000) + "\n");
  f.git("add", "--", name);
  f.git("commit", "--quiet", "-m", "owned large fixture");
  f.write(name, "const amount = 2;\n//" + "x".repeat(90000) + "\n");
  const list = await allChanges(f.service),
    file = list.files.find((f) => f.file === name);
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const input = {
    title: "Repeated excerpts",
    listId: list.listId,
    steps: Array.from({ length: 100 }, (_, i) => ({
      id: "step" + i,
      title: "Step " + i,
      fileId: file.id,
      binding: view.binding,
      before: authoredSide("Before", "Earlier initialization"),
      after: authoredSide("After", "Later initialization"),
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1024 * 1024);
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", input),
    /Expanded.*8 MiB/
  );
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
  const saved = await f.service.call("create_comparison_walkthrough", {
    ...input,
    steps: input.steps.slice(0, 8),
  });
  assert.equal(saved.steps.length, 8);
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 8 * 1024 * 1024);
  assert.equal(saved.steps[7].file.id, file.id);
  assert.equal(saved.steps[7].binding, view.binding);
  assert.equal(saved.steps[7].after.code.excerpt, "const amount = 2;");
  await f.reopen();
  assert.deepEqual(
    await f.service.call("get_comparison_walkthrough", { id: saved.id }),
    saved
  );
});

test("Near-view-budget note history rejects before commitment and remains readable/deletable", async (t) => {
  const f = await gitProject(t);
  f.write("large.ts", "const amount = 1;\n//" + "x".repeat(90000) + "\n");
  f.git("add", "--", "large.ts");
  f.git("commit", "--quiet", "-m", "owned view capacity fixture");
  f.write("large.ts", "const amount = 2;\n//" + "x".repeat(90000) + "\n");
  const list = await allChanges(f.service),
    file = list.files.find((f) => f.file === "large.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "View capacity",
    listId: list.listId,
    steps: Array.from({ length: 17 }, (_, i) => ({
      id: "step" + i,
      title: "Step " + i,
      fileId: file.id,
      binding: view.binding,
      before: authoredSide("Before", "Earlier initialization"),
      after: authoredSide("After", "Later initialization"),
    })),
  });
  let group = saved.steps[0].annotations,
    noteId;
  let rejected = false;
  for (let i = 0; i < 140; i++) {
    const previous = group;
    try {
      group = await f.service.call("save_walkthrough_comparison_note", {
        walkthroughId: saved.id,
        stepId: "step0",
        side: "after",
        binding: view.binding,
        expectedRevision: group.revision,
        ...(noteId ? { noteId } : {}),
        body: "n".repeat(9000),
        author: "Human",
        attachments: [],
      });
      noteId = group.notes.at(-1).id;
    } catch (error) {
      assert.match(error.message, /Expanded.*8 MiB/);
      rejected = true;
      assert.deepEqual(
        (await f.service.call("get_comparison_walkthrough", { id: saved.id }))
          .steps[0].annotations,
        previous
      );
      break;
    }
  }
  assert.equal(rejected, true);
  group = await f.service.call("delete_walkthrough_comparison_note", {
    walkthroughId: saved.id,
    stepId: "step0",
    scope: group.scope,
    noteId,
    expectedRevision: group.revision,
  });
  await f.reopen();
  const read = await f.service.call("get_comparison_walkthrough", {
    id: saved.id,
  });
  assert.deepEqual(read.steps[0].annotations, group);
  assert.ok(Buffer.byteLength(JSON.stringify(read)) < 8 * 1024 * 1024);
});

test("A sub-1MiB request repeating large valid attachments rejects promptly with no partial guide", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 7; // " + "x".repeat(80000) + "\n");
  const list = await allChanges(f.service),
    file = list.files.find((f) => f.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const after = authoredSide("After", "An expanded block");
  after.notes = Array.from({ length: 1400 }, () => ({
    body: "Same exact block",
    startLine: 1,
    endLine: 1,
  }));
  const input = {
    title: "Expanded attachments",
    listId: list.listId,
    steps: [
      {
        id: "one",
        title: "One",
        fileId: file.id,
        binding: view.binding,
        before: authoredSide("Before", "Earlier block"),
        after,
      },
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1024 * 1024);
  const start = performance.now();
  await assert.rejects(
    f.service.call("create_comparison_walkthrough", input),
    /2 MiB/
  );
  const elapsed = performance.now() - start;
  t.diagnostic(`Public rejection in ${Math.round(elapsed)}ms`);
  assert.ok(
    elapsed < 2500,
    "Expanded budget must reject before quadratic accumulated-group cloning"
  );
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
  await f.reopen();
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
});

test("Raw CRLF attachment bytes survive authored projection; normalized Git hunks are not guessed onto raw working source", async (t) => {
  const f = await gitProject(t);
  f.write(".gitattributes", "part.ts text eol=crlf\n");
  f.write("part.ts", "const amount = 7;\r\nunchanged\r\n");
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "part.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  const saved = await f.service.call("create_comparison_walkthrough", {
    title: "Raw bytes",
    listId: list.listId,
    steps: [
      {
        id: "one",
        title: "Raw source",
        fileId: file.id,
        binding: view.binding,
        before: authoredSide("Before", "Earlier literal source"),
        after: authoredSide("After", "Saved CRLF source"),
      },
    ],
  });
  assert.equal(saved.steps[0].after.code.excerpt, "const amount = 7;\r");
  assert.equal(
    saved.steps[0].annotations.notes.find(
      (n) => n.side === "after" && !n.variableName
    ).attachments[0].text,
    "const amount = 7;\r"
  );
  assert.equal(saved.steps[0].patchMatchesRaw.after, false);
  assert.equal(saved.steps[0].patchMatchesRaw.before, true);
});

test("An early selected working file changed while a multi-file authoring request awaits later Git work refuses the complete write", async (t) => {
  const f = await gitProject(t);
  for (let i = 0; i < 10; i++)
    f.write(
      `batch-${i}.ts`,
      "const amount = 7;\n" + "// bounded context\n".repeat(100)
    );
  const list = await allChanges(f.service);
  const steps = [];
  for (const file of list.files.filter((file) =>
    file.file.startsWith("batch-")
  )) {
    const view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
    steps.push({
      id: "pair-" + steps.length,
      title: "Explicit new behavior",
      fileId: file.id,
      binding: view.binding,
      before: {
        title: "Absent before",
        purpose: "The untracked source did not exist.",
        startLine: 0,
        endLine: 0,
        notes: [],
        variables: [],
        notApplicable: {
          notes: "No before source blocks.",
          variables: "No before identifiers.",
        },
      },
      after: authoredSide("Present after", "Read the added constant"),
    });
  }
  let settled = false;
  const pending = f.service
    .call("create_comparison_walkthrough", {
      title: "Must reject whole batch",
      listId: list.listId,
      steps,
    })
    .finally(() => {
      settled = true;
    });
  const refused = assert.rejects(pending, /changed/i);
  await delay(350);
  assert.equal(
    settled,
    false,
    "The real public batch must still be awaiting Git work at mutation time"
  );
  f.write("batch-0.ts", "const amount = 99;\n");
  await refused;
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
  assert.equal((await f.service.call("project_overview", {})).revision, 0);
});
