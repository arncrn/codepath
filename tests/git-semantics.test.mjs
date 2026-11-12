import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";
import { startProjectService } from "../dist/service.mjs";

const compare = (base, target) => ({ mode: "compare", base, target });
const read = (f, list, file) =>
  f.service.call("get_git_file", { listId: list.listId, fileId: file.id });

test("Committed local branches stay committed; working-tree comparison includes staged, unstaged, untracked and deletion without checkout", async (t) => {
  const f = await gitProject(t);
  const initial = f.git("rev-parse", "HEAD").trim();
  f.write("part.ts", "branch two\n");
  f.git("add", "--", "part.ts");
  f.git("commit", "--quiet", "-m", "branch change");
  f.write("part.ts", "staged three\n");
  f.git("add", "--", "part.ts");
  f.write("part.ts", "saved four\n");
  f.write("untracked.txt", "fresh\n");
  const refs = await f.service.call("list_git_branches", {});
  assert.equal(refs.branches.find((b) => b.name === "equal").oid, initial);
  assert.deepEqual(
    (await allChanges(f.service, compare("HEAD", "refs/heads/main"))).files,
    []
  );
  let list = await allChanges(
    f.service,
    compare("refs/heads/equal", "refs/heads/main")
  );
  let view = await read(f, list, list.files[0]);
  assert.equal(view.before.content, "const amount = 1;\nunchanged\n");
  assert.equal(view.after.content, "branch two\n");
  list = await allChanges(
    f.service,
    compare("refs/heads/equal", "WORKING_TREE")
  );
  assert.deepEqual(
    list.files.map((file) => file.file),
    ["part.ts", "untracked.txt"]
  );
  view = await read(f, list, list.files[0]);
  assert.equal(view.after.content, "saved four\n");
  fs.unlinkSync(path.join(f.root, "part.ts"));
  list = await allChanges(f.service, compare("HEAD", "WORKING_TREE"));
  view = await read(
    f,
    list,
    list.files.find((file) => file.file === "part.ts")
  );
  assert.equal(view.file.status, "deleted");
  assert.equal(view.after.content, "");
  assert.match(view.patch, /-branch two/);
  assert.equal(f.git("symbolic-ref", "HEAD").trim(), "refs/heads/main");
});

test("Unborn/empty repo needs no capture or artificial HEAD; staged additions and empty files remain inspectable", async (t) => {
  const f = await gitProject(t, { unborn: true });
  fs.unlinkSync(path.join(f.root, "part.ts"));
  assert.equal((await f.service.call("list_git_branches", {})).head, undefined);
  f.write("empty.txt", "");
  f.write("added.ts", "added\n");
  f.git("add", "--", "added.ts", "empty.txt", ".gitignore");
  const list = await allChanges(f.service);
  const view = await read(
    f,
    list,
    list.files.find((file) => file.file === "added.ts")
  );
  assert.equal(view.before.content, "");
  assert.equal(view.before.label, "Empty (unborn HEAD)");
  assert.match(view.patch, /\+added/);
  assert.equal(
    (
      await read(
        f,
        list,
        list.files.find((file) => file.file === "empty.txt")
      )
    ).file.status,
    "added"
  );
  await assert.rejects(
    allChanges(f.service, compare("HEAD", "WORKING_TREE")),
    /available local branch/
  );
});

test("Deletions, exact renames, mode-only changes and odd filenames retain actual bytes/paths", async (t) => {
  const f = await gitProject(t);
  const odd = "space\ttab\n世界.ts";
  f.write(odd, "old odd\n");
  f.write("executable.sh", "echo fixture\n");
  f.git("add", "--", odd, "executable.sh");
  f.git("commit", "--quiet", "-m", "paths");
  fs.renameSync(path.join(f.root, odd), path.join(f.root, "renamed " + odd));
  f.git("add", "--", odd, "renamed " + odd);
  fs.chmodSync(path.join(f.root, "executable.sh"), 0o755);
  fs.unlinkSync(path.join(f.root, "part.ts"));
  const list = await allChanges(f.service);
  const renamed = list.files.find((file) => file.status === "renamed");
  assert.equal(renamed.oldFile, odd);
  assert.equal(renamed.file, "renamed " + odd);
  let view = await read(f, list, renamed);
  assert.equal(view.before.content, "old odd\n");
  assert.equal(view.after.content, "old odd\n");
  assert.equal(view.patch, "");
  view = await read(
    f,
    list,
    list.files.find((file) => file.file === "executable.sh")
  );
  assert.equal(view.before.mode, "100644");
  assert.equal(view.after.mode, "100755");
  assert.equal(view.patch, "");
  view = await read(
    f,
    list,
    list.files.find((file) => file.file === "part.ts")
  );
  assert.equal(view.after.content, "");
  assert.match(view.patch, /-const amount = 1/);
});

test("Subfolder scope and root aliases never expose sibling contents; a second worktree's uncommitted files are never branch contents", async (t) => {
  const f = await gitProject(t, { subfolder: "project" });
  f.write("project/a.txt", "inside\n");
  f.write("outside.txt", "outside\n");
  let list = await allChanges(f.service);
  assert.deepEqual(
    list.files.map((file) => file.file),
    ["a.txt"]
  );
  const alias = fs.mkdtempSync(path.join(os.tmpdir(), "cp-git-alias-"));
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }));
  fs.symlinkSync(path.join(f.root, "project"), path.join(alias, "project"));
  const attached = await startProjectService(path.join(alias, "project"), {
    assetsRoot: path.resolve("dist"),
    reuse: true,
  });
  assert.equal(attached.owned, false);
  assert.equal(attached.root, fs.realpathSync(path.join(f.root, "project")));
  list = await allChanges(attached);
  assert.equal(list.files[0].file, "a.txt");
  await attached.close();
  const worktree = path.join(alias, "worktree");
  f.git("worktree", "add", "--quiet", "-b", "other", worktree);
  fs.writeFileSync(path.join(worktree, "part.ts"), "other worktree dirty\n");
  const other = await startProjectService(worktree, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(() => other.close());
  assert.deepEqual(
    (await allChanges(other, compare("refs/heads/main", "refs/heads/other")))
      .files,
    []
  );
  list = await allChanges(other, compare("refs/heads/main", "WORKING_TREE"));
  const view = await other.call("get_git_file", {
    listId: list.listId,
    fileId: list.files.find((file) => file.file === "part.ts").id,
  });
  assert.equal(view.after.content, "other worktree dirty\n");
});

test("Pagination covers late nonignored paths, including query-bound empty pages; no arbitrary first-N source eligibility", async (t) => {
  const f = await gitProject(t);
  for (let i = 0; i < 311; i++)
    f.write(`many/file-${String(i).padStart(4, "0")}.txt`, `${i}\n`);
  let page = await f.service.call("list_git_changes", {
    query: { mode: "changes" },
  });
  assert.equal(page.complete, false);
  assert.ok(page.files.length <= 100);
  await assert.rejects(
    f.service.call("list_git_changes", {
      query: compare("HEAD", "WORKING_TREE"),
      cursor: page.nextCursor,
    }),
    /continuation/i
  );
  const files = [...page.files];
  while (!page.complete) {
    page = await f.service.call("list_git_changes", {
      query: { mode: "changes" },
      cursor: page.nextCursor,
    });
    files.push(...page.files);
  }
  assert.equal(files.length, 311);
  assert.equal(new Set(files.map((file) => file.id)).size, 311);
  const view = await f.service.call("get_git_file", {
    listId: page.listId,
    fileId: files.at(-1).id,
  });
  assert.equal(view.after.content, "310\n");
});

test("Ref/index/disk changes invalidate old file admission rather than returning another comparison", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "changed\n");
  let list = await allChanges(f.service),
    file = list.files[0];
  f.write("part.ts", "newer\n");
  await assert.rejects(read(f, list, file), /changed/i);
  list = await allChanges(f.service);
  file = list.files[0];
  f.git("add", "--", "part.ts");
  await assert.rejects(read(f, list, file), /changed/i);
  list = await allChanges(
    f.service,
    compare("refs/heads/equal", "WORKING_TREE")
  );
  file = list.files[0];
  f.git("commit", "--quiet", "-m", "move HEAD");
  f.git("branch", "-f", "equal", "HEAD");
  await assert.rejects(read(f, list, file), /changed/i);
});

test("Private tracked state, malicious refs, symlinks and executable Git configuration are not source/execution channels", async (t) => {
  const f = await gitProject(t);
  f.write(".codepaths/secret.ts", "fixture private marker\n");
  f.write(".env", "fixture env marker\n");
  f.git("add", "-f", "--", ".codepaths/secret.ts", ".env");
  f.git("commit", "--quiet", "-m", "malicious tracked fixture state");
  const marker = path.join(f.root, "executed-marker");
  f.write("hostile.sh", `#!/bin/sh\nprintf executed > '${marker}'\n`);
  fs.chmodSync(path.join(f.root, "hostile.sh"), 0o755);
  f.git("config", "core.fsmonitor", path.join(f.root, "hostile.sh"));
  f.git("config", "diff.external", path.join(f.root, "hostile.sh"));
  f.git("config", "filter.hostile.clean", path.join(f.root, "hostile.sh"));
  f.git("config", "diff.hostile.textconv", path.join(f.root, "hostile.sh"));
  const keys = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_EXTERNAL_DIFF",
  ];
  const previous = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    })
  );
  Object.assign(process.env, {
    GIT_DIR: path.join(f.root, "not-the-repo"),
    GIT_WORK_TREE: path.dirname(f.root),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: path.join(f.root, "hostile.sh"),
    GIT_EXTERNAL_DIFF: path.join(f.root, "hostile.sh"),
  });
  f.write(".gitattributes", "*.ts filter=hostile diff=hostile\n");
  f.write("part.ts", "literal raw contents\n");
  fs.symlinkSync(
    path.join(f.root, ".codepaths/secret.ts"),
    path.join(f.root, "link.ts")
  );
  fs.symlinkSync(
    path.join(f.root, ".codepaths"),
    path.join(f.root, "linked-dir")
  );
  const list = await allChanges(f.service);
  assert.ok(
    list.files.every(
      (file) => !file.file.includes(".codepaths") && file.file !== ".env"
    )
  );
  const view = await read(
    f,
    list,
    list.files.find((file) => file.file === "part.ts")
  );
  assert.equal(view.after.content, "literal raw contents\n");
  const link = await read(
    f,
    list,
    list.files.find((file) => file.file === "link.ts")
  );
  assert.equal(link.after.mode, "120000");
  assert.ok(!link.after.content.includes("fixture private marker"));
  assert.equal(fs.existsSync(marker), false);
  for (const base of [
    "--exec=sh",
    "main; touch marker",
    "refs/heads/main^{tree}",
    "../part.ts",
    "refs/remotes/origin/main",
  ])
    await assert.rejects(
      allChanges(f.service, compare(base, "WORKING_TREE")),
      /available local branch/i
    );
  await assert.rejects(
    f.service.call("get_git_file", {
      listId: list.listId,
      fileId: "../.codepaths/secret.ts",
    }),
    /not in this comparison/
  );
  assert.equal(fs.existsSync(marker), false);
});

test("A nonrepository reports an ordinary unavailable message without creating Git state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-nonrepo-"));
  const service = await startProjectService(root, {
    assetsRoot: path.resolve("dist"),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(
    allChanges(service),
    /not an available Git working repository/
  );
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
});

test("Even an empty comparison signals branch movement and unselected saved-file changes without rewriting notes or source", async (t) => {
  const f = await gitProject(t);
  const empty = await allChanges(
    f.service,
    compare("refs/heads/main", "refs/heads/equal")
  );
  assert.equal(
    (await f.service.call("check_git_comparison", { listId: empty.listId }))
      .current,
    true
  );
  f.write("part.ts", "moved branch\n");
  f.git("add", "--", "part.ts");
  f.git("commit", "--quiet", "-m", "move main");
  assert.equal(
    (await f.service.call("check_git_comparison", { listId: empty.listId }))
      .current,
    false
  );
  const unchanged = await allChanges(f.service);
  assert.deepEqual(unchanged.files, []);
  f.write("part.ts", "dirty saved file\n");
  assert.equal(
    (await f.service.call("check_git_comparison", { listId: unchanged.listId }))
      .current,
    false
  );
});

test("SHA-256 Git object identities work without inventing unchanged working files", async (t) => {
  const f = await gitProject(t, { objectFormat: "sha256" });
  assert.deepEqual((await allChanges(f.service)).files, []);
  f.write("part.ts", "sha256 working bytes\n");
  const list = await allChanges(f.service);
  assert.equal(list.files.length, 1);
  assert.equal(
    (await read(f, list, list.files[0])).before.content,
    "const amount = 1;\nunchanged\n"
  );
  assert.equal(
    (await read(f, list, list.files[0])).after.content,
    "sha256 working bytes\n"
  );
});

test("Unmerged entries never pretend a stage is the index result, and every conflict-stage change invalidates admission", async (t) => {
  const f = await gitProject(t);
  const base = f.git("rev-parse", "HEAD:part.ts").trim();
  const ours = f
    .gitInput("ours fixture\n", "hash-object", "-w", "--stdin")
    .trim();
  const install = (second) =>
    f.gitInput(
      `0 ${"0".repeat(40)}\tpart.ts\n100644 ${base} 1\tpart.ts\n100644 ${second} 2\tpart.ts\n100644 ${base} 3\tpart.ts\n`,
      "update-index",
      "--index-info"
    );
  install(ours);
  const list = await allChanges(f.service);
  assert.deepEqual(
    list.files.map((file) => file.group),
    ["staged", "unstaged"]
  );
  for (const file of list.files)
    assert.match((await read(f, list, file)).unavailable, /Unmerged/);
  install(base);
  await assert.rejects(read(f, list, list.files[0]), /changed/i);
});
