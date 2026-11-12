import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";
const read = (f, list, file) =>
  f.service.call("get_git_file", { listId: list.listId, fileId: file.id });

test("Built-in text/eol/legacy crlf rules match Git checkouts; ambiguous ident is unavailable and raw admission stays exact", async (t) => {
  const f = await gitProject(t);
  f.write(
    ".gitattributes",
    "part.ts text eol=crlf\nlegacy.txt crlf\nlf.txt eol=lf\nident.txt ident\nraw.txt -text\nauto.txt text=auto\n"
  );
  for (const name of ["legacy.txt", "lf.txt", "raw.txt", "auto.txt"])
    f.write(name, "one\ntwo\n");
  f.write("ident.txt", "$Id$\n");
  f.git(
    "add",
    "--",
    ".gitattributes",
    "legacy.txt",
    "lf.txt",
    "raw.txt",
    "auto.txt",
    "ident.txt"
  );
  f.git("commit", "--quiet", "-m", "built-in attributes");
  fs.unlinkSync(path.join(f.root, "part.ts"));
  fs.unlinkSync(path.join(f.root, "ident.txt"));
  f.git("checkout", "--", "part.ts", "ident.txt");
  assert.match(fs.readFileSync(path.join(f.root, "part.ts"), "utf8"), /\r\n/);
  assert.match(
    fs.readFileSync(path.join(f.root, "ident.txt"), "utf8"),
    /\$Id: [a-f0-9]+ \$/
  );
  f.git("config", "core.eol", "crlf");
  for (const name of ["legacy.txt", "lf.txt", "auto.txt"])
    fs.unlinkSync(path.join(f.root, name));
  f.git("checkout", "--", "legacy.txt", "lf.txt", "auto.txt");
  assert.equal(f.git("status", "--porcelain").trim(), "");
  async function unchangedWithIdentUnknown() {
    const list = await allChanges(f.service);
    assert.deepEqual(
      list.files.map(({ file, status }) => ({ file, status })),
      [{ file: "ident.txt", status: "unavailable" }]
    );
    const view = await read(f, list, list.files[0]);
    assert.match(view.unavailable, /ident/);
  }
  await unchangedWithIdentUnknown();
  f.write("lf.txt", "one\r\ntwo\r\n");
  assert.equal(f.git("diff", "--no-ext-diff", "--no-textconv").trim(), "");
  await unchangedWithIdentUnknown();
  f.write("raw.txt", "one\r\ntwo\r\n");
  assert.match(f.git("status", "--porcelain"), /raw.txt/);
  assert.deepEqual(
    (await allChanges(f.service)).files
      .filter((file) => file.file !== "ident.txt")
      .map((file) => file.file),
    ["raw.txt"]
  );
  f.write("part.ts", "const amount = 2;\r\nunchanged\r\n");
  const list = await allChanges(f.service);
  const view = await read(
    f,
    list,
    list.files.find((x) => x.file === "part.ts")
  );
  assert.match(view.patch, /-const amount = 1;/);
  assert.match(view.patch, /\+const amount = 2;/);
  assert.ok(!view.patch.includes("+unchanged"));
  assert.equal(view.after.content, "const amount = 2;\r\nunchanged\r\n");
  const input = {
    listId: view.listId,
    fileId: view.file.id,
    binding: view.binding,
    side: "after",
    expectedRevision: 0,
    body: "Exact CRLF identifier",
    author: "Human",
    variableName: "amount",
    attachments: [
      {
        file: "part.ts",
        fileHash: view.after.code.fileHash,
        startLine: 1,
        endLine: 1,
        startColumn: 6,
        endColumn: 12,
        text: "amount",
      },
    ],
  };
  const saved = await f.service.call("save_comparison_note", input);
  assert.equal(saved.notes[0].hash, view.after.code.hash);
  f.write("part.ts", "const amount = 2;\nunchanged\n");
  await assert.rejects(
    f.service.call("save_comparison_note", {
      ...input,
      expectedRevision: 1,
      noteId: saved.notes[0].id,
    }),
    /changed/i
  );
  const fresh = await allChanges(f.service);
  const newer = await read(
    f,
    fresh,
    fresh.files.find((x) => x.file === "part.ts")
  );
  assert.equal(newer.annotations.notes[0].stale, true);
});

test("Auto normalization preserves CRLF index content and binary heuristics instead of guessing text", async (t) => {
  const f = await gitProject(t);
  f.write("auto.txt", "old\r\nkept\r\n");
  f.write("binary.bin", Buffer.from([0, 13, 10, 65]));
  f.git("add", "--", "auto.txt", "binary.bin");
  f.git("commit", "--quiet", "-m", "raw CRLF index");
  f.write(".gitattributes", "auto.txt text=auto\nbinary.bin text=auto\n");
  f.git("add", "--", ".gitattributes");
  f.git("commit", "--quiet", "-m", "auto without renormalization");
  f.git("config", "core.autocrlf", "input");
  assert.deepEqual((await allChanges(f.service)).files, []);
  f.write("auto.txt", "new\r\nkept\r\n");
  f.write("binary.bin", Buffer.from([0, 10, 65]));
  const list = await allChanges(f.service);
  assert.deepEqual(
    list.files.map((x) => x.file),
    ["auto.txt", "binary.bin"]
  );
  assert.match(f.git("status", "--porcelain"), /auto.txt/);
  const view = await read(f, list, list.files[0]);
  assert.match(view.patch, /\+new\r/);
  assert.equal(
    (await read(f, list, list.files[1])).unavailable,
    "Binary content: text diff unavailable."
  );
});

test("Custom filters and unsupported encodings are unknown, never ordinary modifications or executable commands", async (t) => {
  const f = await gitProject(t);
  const marker = path.join(f.root, "executed");
  f.git("config", "filter.unsafe.clean", `touch '${marker}'`);
  f.git("config", "filter.unsafe.smudge", `touch '${marker}'`);
  f.write(
    ".gitattributes",
    "part.ts filter=unsafe\nencoded.txt working-tree-encoding=UTF-16\n"
  );
  f.write("encoded.txt", "plain saved fixture\n");
  let list = await allChanges(f.service);
  for (const name of ["part.ts", "encoded.txt"]) {
    const file = list.files.find((x) => x.file === name);
    assert.equal(file.status, "unavailable");
    const view = await read(f, list, file);
    assert.match(
      view.unavailable,
      /Unknown Git normalization|Unsupported Git working-tree-encoding/
    );
    assert.equal(view.patch, "");
  }
  // A concurrent attribute/config change cannot introduce executable filters:
  // no later command ever requests conversion on a repository path.
  f.write(".gitattributes", "part.ts text eol=crlf\n");
  f.write("part.ts", "const amount = 2;\r\nunchanged\r\n");
  list = await allChanges(f.service);
  const view = await read(
    f,
    list,
    list.files.find((x) => x.file === "part.ts")
  );
  const pending = f.service.call("save_comparison_note", {
    listId: view.listId,
    fileId: view.file.id,
    binding: view.binding,
    side: "after",
    expectedRevision: 0,
    body: "must refuse",
    author: "Human",
    attachments: [],
  });
  const refused = assert.rejects(pending, /changed/i);
  f.write(".gitattributes", "part.ts filter=unsafe\n");
  await refused;
  assert.equal(fs.existsSync(marker), false);
  const committed = await allChanges(f.service, {
    mode: "compare",
    base: "HEAD",
    target: "refs/heads/equal",
  });
  assert.deepEqual(committed.files, []);
});
