import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

test("Allowed inventory enumerates every page while restricted working coverage stays explicitly unknown without private previews", async (t) => {
  const f = await gitProject(t);
  f.write(".env", "private fixture bytes\n");
  f.git("add", "-f", "--", ".env");
  f.write(".env.local", "private untracked fixture bytes\n");
  for (let i = 0; i < 111; i++)
    f.write(`changes/${i}.txt`, "ordinary diff only\n");
  const list = await allChanges(f.service);
  assert.equal(list.files.length, 111);
  assert.equal(list.coverage.allowed.complete, true);
  assert.equal(list.coverage.allowed.listedPairs, 111);
  assert.equal(list.coverage.restricted.candidatePaths, 2);
  assert.equal(list.coverage.restricted.knownChangedPaths, 1);
  assert.equal(list.coverage.restricted.workingChanges, "unknown");
  assert.ok(!JSON.stringify(list).includes("private fixture bytes"));
  assert.ok(!list.files.some((file) => file.file.startsWith(".env")));
  assert.deepEqual(
    await f.service.call("list_comparison_walkthroughs", {}),
    []
  );
});

test("A candidate whose normalization inspection exceeds budget remains visible as unknown rather than disappearing or becoming clean", async (t) => {
  const f = await gitProject(t);
  f.write("large-auto.txt", "x".repeat(8 * 1024 * 1024 + 1));
  f.git("add", "--", "large-auto.txt");
  f.git("commit", "--quiet", "-m", "owned overbudget index fixture");
  f.write(".gitattributes", "large-auto.txt text=auto\n");
  f.write("large-auto.txt", "small changed source\n");
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "large-auto.txt");
  assert.equal(file.status, "unavailable");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  assert.match(view.unavailable, /8 MiB/);
  const pair = (
    await f.service.call("get_git_viewed", { listId: list.listId })
  ).pairs.find((pair) => pair.fileId === file.id);
  assert.equal(pair.identity, undefined);
  assert.ok(fs.existsSync(path.join(f.root, "large-auto.txt")));
});

test("An untracked source inspection failure reports unknown working mode, never fictional absence or index mode", async (t) => {
  const f = await gitProject(t);
  f.write("unreadable.txt", "owned unreadable fixture\n");
  const target = path.join(f.root, "unreadable.txt");
  fs.chmodSync(target, 0);
  try {
    const list = await allChanges(f.service),
      file = list.files.find((file) => file.file === "unreadable.txt");
    assert.equal(file.status, "unavailable");
    const view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
    assert.equal(view.before.mode, "000000");
    assert.equal(view.after.mode, "unknown");
    assert.equal(view.after.content, undefined);
    assert.match(view.unavailable, /EACCES|EPERM/);
    const progress = await f.service.call("get_git_viewed", {
      listId: list.listId,
    });
    assert.equal(
      progress.pairs.find((pair) => pair.fileId === file.id).identity,
      undefined
    );
  } finally {
    fs.chmodSync(target, 0o644);
  }
});

test("Nonregular working candidates are visible without blocking reads and cannot pretend absence or exact Viewed identity", async (t) => {
  const f = await gitProject(t);
  f.write("nonregular.txt", "before regular source\n");
  f.git("add", "--", "nonregular.txt");
  f.git("commit", "--quiet", "-m", "owned nonregular fixture");
  const target = path.join(f.root, "nonregular.txt");
  fs.unlinkSync(target);
  execFileSync("/usr/bin/mkfifo", [target], { timeout: 5000 });
  const list = await allChanges(f.service),
    file = list.files.find((file) => file.file === "nonregular.txt");
  assert.equal(file.status, "unavailable");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });
  assert.equal(view.after.mode, "unknown");
  assert.match(view.after.unavailable, /nonregular/);
  const pair = (
    await f.service.call("get_git_viewed", { listId: list.listId })
  ).pairs.find((pair) => pair.fileId === file.id);
  assert.equal(pair.identity, undefined);
  assert.match(pair.disabledReason, /Exact source identity unavailable/);
});

test("Empty continuation pages do not end inventory and an earlier skipped working file cannot change beneath complete coverage", async (t) => {
  const f = await gitProject(t);
  for (let i = 0; i < 110; i++)
    f.write(`a-${String(i).padStart(3, "0")}.txt`, "same\n");
  f.git("add", "--", ".");
  f.git("commit", "--quiet", "-m", "unchanged candidates");
  f.write("z-late.txt", "late diff\n");
  const query = { mode: "changes" };
  const first = await f.service.call("list_git_changes", { query });
  assert.equal(first.complete, false);
  assert.equal(first.files.length, 0);
  assert.equal(first.coverage.allowed.complete, false);
  f.write("a-000.txt", "changed after its eligibility scan\n");
  let page = first;
  await assert.rejects(async () => {
    while (!page.complete)
      page = await f.service.call("list_git_changes", {
        query,
        cursor: page.nextCursor,
      });
  }, /changed|incomplete/i);
  const fresh = await allChanges(f.service);
  assert.deepEqual(
    fresh.files.map((file) => file.file),
    ["a-000.txt", "z-late.txt"]
  );
  assert.equal(fresh.coverage.allowed.complete, true);
});
