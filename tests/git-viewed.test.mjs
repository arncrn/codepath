import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";
import { authorFixture } from "./fixtures/authored-comparison.mjs";

async function progress(f, query = { mode: "changes" }) {
  const list = await allChanges(f.service, query);
  const viewed = await f.service.call("get_git_viewed", {
    listId: list.listId,
  });
  return { ...list, pairs: viewed.pairs, query };
}
test("Current file offers lightweight optional authored links only for its exact selected full binding and query", async (t) => {
  const f = await gitProject(t);
  const { saved, first } = await authorFixture(f);
  const request = {
    query: { mode: "changes" },
    fileId: first.file.id,
    binding: first.binding,
  };
  const links = await f.service.call("list_git_explanations", request);
  assert.deepEqual(links, [
    {
      walkthroughId: saved.id,
      title: saved.title,
      stepId: saved.steps[0].id,
      stepTitle: saved.steps[0].title,
    },
  ]);
  assert.deepEqual(
    await f.service.call("list_git_explanations", {
      ...request,
      binding: "0".repeat(64),
    }),
    []
  );
  assert.deepEqual(
    await f.service.call("list_git_explanations", {
      ...request,
      query: { mode: "compare", base: "HEAD", target: "WORKING_TREE" },
    }),
    []
  );
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.id === first.file.id);
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  assert.equal(view.binding, first.binding);
});

function mark(f, list, file, pair) {
  return f.service.call("set_git_viewed", {
    query: list.query,
    fileId: file.id,
    identity: pair.identity,
    expectedRevision: pair.revision,
  });
}

test("Viewed is manual exact-pair progress, survives restart, changes only with that pair and keeps source-independent uncheck tombstones", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  f.write("other.txt", "independent\n");
  let list = await progress(f);
  const file = list.files.find((file) => file.file === "part.ts");
  const pair = list.pairs.find((pair) => pair.fileId === file.id);
  assert.equal(pair.viewed, false);
  await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  assert.equal(
    (await progress(f)).pairs.find((p) => p.fileId === file.id).viewed,
    false
  );
  const saved = await mark(f, list, file, pair);
  assert.equal(saved.viewed, true);
  await f.reopen();
  list = await progress(f);
  assert.equal(list.pairs.find((p) => p.fileId === file.id).viewed, true);
  f.write("other.txt", "unrelated source moved\n");
  list = await progress(f);
  assert.equal(list.pairs.find((p) => p.fileId === file.id).viewed, true);
  f.write("part.ts", "const amount = 3;\nunchanged\n");
  list = await progress(f);
  const newer = list.pairs.find((p) => p.fileId === file.id);
  assert.notEqual(newer.identity, pair.identity);
  assert.equal(newer.viewed, false);
  await assert.rejects(mark(f, list, file, pair), /changed|identity/i);
  const cleared = await f.service.call("clear_git_viewed", {
    identity: saved.identity,
    expectedRevision: saved.revision,
  });
  assert.equal(cleared.viewed, false);
  await assert.rejects(
    f.service.call("clear_git_viewed", {
      identity: saved.identity,
      expectedRevision: saved.revision,
    }),
    /revision|changed/i
  );
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  list = await progress(f);
  assert.deepEqual(
    list.pairs.find((p) => p.fileId === file.id),
    { fileId: file.id, ...cleared }
  );
  await assert.rejects(mark(f, list, file, pair), /revision|changed/i);
});

test("Exact binary identity admits manual progress but a stat-only overbudget working file cannot be Viewed", async (t) => {
  const f = await gitProject(t);
  f.write("binary.bin", Buffer.from([0, 255, 1]));
  f.write("huge.bin", "x".repeat(8 * 1024 * 1024 + 1));
  const list = await progress(f);
  const binary = list.files.find((file) => file.file === "binary.bin");
  const pair = list.pairs.find((p) => p.fileId === binary.id);
  assert.match(pair.identity, /^[a-f0-9]{64}$/);
  assert.equal((await mark(f, list, binary, pair)).viewed, true);
  const huge = list.files.find((file) => file.file === "huge.bin");
  const unknown = list.pairs.find((p) => p.fileId === huge.id);
  assert.equal(unknown.identity, undefined);
  assert.match(unknown.disabledReason, /exact|8 MiB|inspected/i);
  await assert.rejects(
    mark(f, list, huge, { identity: "0".repeat(64), revision: 0 }),
    /identity|inspected|exact/i
  );
});

test("Partially staged pairs, comparison choices, raw modes and per-file metadata are isolated while unrelated ref/index changes preserve progress", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  f.git("add", "--", "part.ts");
  f.write("part.ts", "const amount = 3;\nunchanged\n");
  let list = await progress(f);
  const staged = list.files.find((file) => file.group === "staged"),
    unstaged = list.files.find((file) => file.group === "unstaged");
  const stagedPair = list.pairs.find((pair) => pair.fileId === staged.id);
  await mark(f, list, staged, stagedPair);
  list = await progress(f);
  assert.equal(list.pairs.filter((p) => p.viewed).length, 1);
  assert.equal(list.pairs.find((p) => p.fileId === unstaged.id).viewed, false);
  const query = { mode: "compare", base: "HEAD", target: "WORKING_TREE" };
  let compared = await progress(f, query),
    file = compared.files.find((file) => file.file === "part.ts");
  let pair = compared.pairs.find((pair) => pair.fileId === file.id);
  assert.equal(pair.viewed, false);
  await mark(f, compared, file, pair);
  f.write("unrelated.txt", "new unrelated commit\n");
  f.git("add", "--", "unrelated.txt");
  // Commit only the unrelated path, leaving the partially staged source intact.
  f.git("commit", "--quiet", "-m", "unrelated", "--", "unrelated.txt");
  compared = await progress(f, query);
  assert.equal(compared.pairs.find((p) => p.fileId === file.id).viewed, true);
  assert.equal(
    (await progress(f, { ...query, base: "refs/heads/main" })).pairs.find(
      (p) => p.fileId === file.id
    ).viewed,
    false
  );
  fs.chmodSync(path.join(f.root, "part.ts"), 0o755);
  compared = await progress(f, query);
  assert.equal(compared.pairs.find((p) => p.fileId === file.id).viewed, false);
  fs.chmodSync(path.join(f.root, "part.ts"), 0o644);
  compared = await progress(f, query);
  assert.equal(compared.pairs.find((p) => p.fileId === file.id).viewed, true);
  f.write(".gitattributes", "part.ts -text\n");
  compared = await progress(f, query);
  assert.equal(compared.pairs.find((p) => p.fileId === file.id).viewed, false);
});

test("A delayed mark cannot bless either new side or survive owner close", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  const list = await progress(f),
    file = list.files[0],
    pair = list.pairs[0];
  f.git("add", "--", "part.ts");
  await assert.rejects(mark(f, list, file, pair), /changed|identity/i);
  let staged = await progress(f),
    stagedFile = staged.files.find((file) => file.group === "staged"),
    stagedPair = staged.pairs.find((pair) => pair.fileId === stagedFile.id);
  await assert.rejects(
    f.service.call("set_git_viewed", {
      query: { mode: "changes" },
      fileId: stagedFile.id,
      identity: "f".repeat(64),
      expectedRevision: 0,
    }),
    /changed|identity/i
  );
  const pending = mark(f, staged, stagedFile, stagedPair);
  const rejected = assert.rejects(pending);
  await f.service.close();
  await rejected;
  await f.reopen();
  staged = await progress(f);
  assert.equal(
    staged.pairs.find((p) => p.fileId === stagedFile.id).viewed,
    false
  );
});

test("Finite Viewed history refuses new identities without eviction, remains clearable at capacity, and rejects invalid reopen without migration", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "changed\n");
  const list = await progress(f),
    file = list.files[0],
    pair = list.pairs[0];
  const saved = await mark(f, list, file, pair);
  await f.service.close();
  const storedFile = path.join(f.root, ".codepaths/workspace.json");
  const stored = JSON.parse(fs.readFileSync(storedFile, "utf8"));
  const records = Array.from({ length: 17050 }, (_, i) => ({
    identity: crypto
      .createHash("sha256")
      .update("owned historical fixture " + i)
      .digest("hex"),
    revision: 9,
    viewed: true,
  }));
  records[0] = { ...saved, revision: 9 };
  stored.gitViewed = records;
  fs.writeFileSync(storedFile, JSON.stringify(stored));
  await f.reopen();
  const atCapacity = (await progress(f)).pairs[0];
  assert.equal(atCapacity.revision, 9);
  const cleared = await f.service.call("clear_git_viewed", {
    identity: saved.identity,
    expectedRevision: 9,
  });
  assert.equal(cleared.revision, 10);
  assert.equal(cleared.viewed, false);
  f.write("part.ts", "different identity at capacity\n");
  const next = await progress(f);
  await assert.rejects(
    mark(f, next, next.files[0], next.pairs[0]),
    /2 MiB|evicted/i
  );
  assert.equal((await progress(f)).pairs[0].viewed, false);
  await f.service.close();
  const validBytes = fs.readFileSync(storedFile);
  const corrupt = JSON.parse(validBytes);
  corrupt.gitViewed[0].revision = -1;
  const corruptBytes = JSON.stringify(corrupt);
  fs.writeFileSync(storedFile, corruptBytes);
  await assert.rejects(f.reopen(), /revision/i);
  assert.equal(
    fs.readFileSync(storedFile, "utf8"),
    corruptBytes,
    "Invalid reopen must not stamp or migrate progress"
  );
  const overbudget = JSON.parse(validBytes);
  overbudget.gitViewed.push({
    identity: "e".repeat(64),
    revision: 1,
    viewed: false,
  });
  fs.writeFileSync(storedFile, JSON.stringify(overbudget));
  await assert.rejects(f.reopen(), /2 MiB/i);
  fs.writeFileSync(storedFile, validBytes);
  await f.reopen();
});

test("A failed viewed save has no successful ACK or in-memory revision/status mutation", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "changed\n");
  const list = await progress(f),
    file = list.files[0],
    pair = list.pairs[0];
  const temporary = path.join(
    f.root,
    `.codepaths/workspace.json.${process.pid}.tmp`
  );
  fs.mkdirSync(temporary);
  await assert.rejects(mark(f, list, file, pair), /EISDIR/);
  fs.rmdirSync(temporary);
  assert.deepEqual((await progress(f)).pairs, list.pairs);
  assert.equal((await mark(f, list, file, pair)).revision, 1);
  await f.reopen();
  assert.equal((await progress(f)).pairs[0].viewed, true);
});
