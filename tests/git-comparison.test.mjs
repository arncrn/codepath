import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

test("Changes separates HEAD→index, index→working file and empty→untracked with exact different contents and real hunks", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  f.git("add", "--", "part.ts");
  f.write("part.ts", "const amount = 3;\nunchanged\n");
  f.write("new file.ts", "new code\n");
  f.write("ignored.txt", "not a change");
  const protectedFiles = [
    ".git/index",
    ".git/config",
    ".git/refs/heads/main",
    "part.ts",
  ];
  const before = protectedFiles.map((file) => [
    fs.readFileSync(path.join(f.root, file)),
    fs.statSync(path.join(f.root, file)).mtimeMs,
  ]);
  const list = await allChanges(f.service);
  assert.deepEqual(
    list.files.map(({ group, file }) => [group, file]).sort(),
    [
      ["staged", "part.ts"],
      ["unstaged", "part.ts"],
      ["untracked", "new file.ts"],
    ].sort()
  );
  for (const [group, left, right, labels] of [
    [
      "staged",
      "const amount = 1;\nunchanged\n",
      "const amount = 2;\nunchanged\n",
      ["HEAD", "Index"],
    ],
    [
      "unstaged",
      "const amount = 2;\nunchanged\n",
      "const amount = 3;\nunchanged\n",
      ["Index", "Working tree (saved)"],
    ],
    ["untracked", "", "new code\n", ["Empty", "Working tree (saved)"]],
  ]) {
    const file = list.files.find((file) => file.group === group);
    const diff = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
    assert.equal(diff.before.content, left);
    assert.equal(diff.after.content, right);
    assert.deepEqual([diff.before.label, diff.after.label], labels);
    assert.match(diff.patch, /@@/);
    assert.match(
      diff.patch,
      group === "untracked" ? /\+new code/ : /-const amount = [12];/
    );
  }
  assert.deepEqual(
    protectedFiles.map((file) => [
      fs.readFileSync(path.join(f.root, file)),
      fs.statSync(path.join(f.root, file)).mtimeMs,
    ]),
    before
  );
});

test("Unchanged large/binary files are not invented as changes; changed nontext content is honestly unavailable", async (t) => {
  const f = await gitProject(t);
  f.write("large.txt", "x".repeat(140 * 1024));
  f.write("binary.bin", Buffer.from([0, 1, 2, 255]));
  f.git("add", "--", "large.txt", "binary.bin");
  f.git("commit", "--quiet", "-m", "large fixtures");
  assert.deepEqual((await allChanges(f.service)).files, []);
  f.write("large.txt", "y".repeat(140 * 1024));
  f.write("binary.bin", Buffer.from([0, 4, 2, 255]));
  f.write("invalid.txt", Buffer.from([255, 254]));
  const list = await allChanges(f.service);
  assert.equal(list.files.length, 3);
  for (const file of list.files) {
    const view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
    assert.match(view.unavailable, /128 KiB|Binary|UTF-8/);
    assert.equal(view.patch, "");
  }
});

test("Oversized/nonregular and symlink-parent sources are explicitly unavailable without reading outside the root", async (t) => {
  const f = await gitProject(t);
  f.write("directory/a.ts", "inside fixture\n");
  f.git("add", "--", "directory/a.ts");
  f.git("commit", "--quiet", "-m", "directory fixture");
  const outside = path.join(f.root, "../outside-" + path.basename(f.root));
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(outside, "a.ts"),
    "outside private fixture marker\n"
  );
  fs.renameSync(path.join(f.root, "directory"), path.join(f.root, "moved"));
  fs.symlinkSync(outside, path.join(f.root, "directory"));
  f.write("huge.txt", "x".repeat(8 * 1024 * 1024 + 1));
  const list = await allChanges(f.service);
  const linked = list.files.find((file) => file.file === "directory/a.ts");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: linked.id,
  });
  assert.match(view.unavailable, /symbolic link/);
  assert.ok(!JSON.stringify(view).includes("outside private fixture marker"));
  const huge = list.files.find((file) => file.file === "huge.txt");
  assert.equal(huge.status, "unavailable");
  assert.match(
    (
      await f.service.call("get_git_file", {
        listId: list.listId,
        fileId: huge.id,
      })
    ).unavailable,
    /8 MiB/
  );
});
