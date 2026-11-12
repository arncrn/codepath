import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

const read = (f, list, file) =>
  f.service.call("get_git_file", {
    listId: list.listId,
    fileId: file.id,
  });

test("BOM-only source edits have real hunks and BOM-leading Unicode filenames remain visible", async (t) => {
  const f = await gitProject(t);
  f.write("part.ts", "\ufeffconst amount = 1;\nunchanged\n");
  let list = await allChanges(f.service);
  const view = await read(
    f,
    list,
    list.files.find((x) => x.file === "part.ts")
  );
  assert.equal(view.after.content, "\ufeffconst amount = 1;\nunchanged\n");
  assert.match(view.patch, /\+\ufeffconst amount = 1;/);
  assert.match(view.patch, /-const amount = 1;/);
  f.write("\ufeffnew.ts", "export const 世界 = 1;\n");
  list = await allChanges(f.service);
  assert.ok(
    list.files.some((x) => x.file === "\ufeffnew.ts"),
    "the first untracked metadata record must preserve its BOM"
  );
  f.write("世界.ts", "another Unicode file\n");
  list = await allChanges(f.service);
  for (const name of ["\ufeffnew.ts", "世界.ts"]) {
    const file = list.files.find((x) => x.file === name);
    assert.ok(file, name);
    assert.equal((await read(f, list, file)).after.file, name);
    assert.match((await read(f, list, file)).patch, /\+/);
  }
});

test("Changes honors safe autocrlf and filemode rules, but staged/index and committed modes remain truth", async (t) => {
  const f = await gitProject(t);
  f.git("config", "core.autocrlf", "true");
  f.git("config", "core.filemode", "false");
  fs.unlinkSync(path.join(f.root, "part.ts"));
  f.git("checkout", "--", "part.ts");
  fs.chmodSync(path.join(f.root, "part.ts"), 0o755);
  assert.equal(f.git("status", "--porcelain").trim(), "");
  assert.deepEqual((await allChanges(f.service)).files, []);
  f.write("part.ts", "const amount = 2;\r\nunchanged\r\n");
  let list = await allChanges(f.service);
  let view = await read(
    f,
    list,
    list.files.find((x) => x.group === "unstaged")
  );
  assert.equal(view.after.content, "const amount = 2;\r\nunchanged\r\n");
  assert.match(view.patch, /-const amount = 1;/);
  assert.match(view.patch, /\+const amount = 2;/);
  assert.ok(
    !view.patch.includes("+unchanged"),
    "normalization must not invent changed context"
  );
  // Only raw bytes admit annotations, even if normalized Git identity is equal.
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  await assert.rejects(read(f, list, list.files[0]), /changed/i);
  f.git("add", "--", "part.ts");
  f.git("update-index", "--chmod=+x", "--", "part.ts");
  list = await allChanges(f.service);
  assert.deepEqual(
    list.files.map((x) => x.group),
    ["staged"]
  );
  view = await read(f, list, list.files[0]);
  assert.equal(view.after.mode, "100755");
  f.write("part.ts", "const amount = 3;\r\nunchanged\r\n");
  list = await allChanges(f.service);
  assert.deepEqual(
    list.files.map((x) => x.group),
    ["staged", "unstaged"]
  );
  view = await read(f, list, list.files[1]);
  assert.equal(view.before.content, "const amount = 2;\nunchanged\n");
  assert.equal(view.after.mode, "100755");
  assert.match(view.patch, /-const amount = 2;/);
  assert.match(view.patch, /\+const amount = 3;/);
  f.git("commit", "--quiet", "-m", "staged truth");
  list = await allChanges(f.service, {
    mode: "compare",
    base: "refs/heads/equal",
    target: "HEAD",
  });
  view = await read(f, list, list.files[0]);
  assert.equal(view.before.mode, "100644");
  assert.equal(view.after.mode, "100755");
});
