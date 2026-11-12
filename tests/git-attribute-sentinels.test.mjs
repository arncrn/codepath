import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitProject, allChanges } from "./fixtures/git-project.mjs";

for (const attribute of ["filter", "working-tree-encoding"]) {
  for (const token of ["set", "unset", "unspecified"]) {
    for (const changed of [false, true]) {
      test(`${attribute}=${token} is unavailable with ${changed ? "different" : "identical"} raw/index bytes; no command executes`, async (t) => {
        const f = await gitProject(t);
        const marker = path.join(f.root, "executed");
        // Install only AFTER the base commit. No fixture or product invocation
        // requests conversion after this point: these commands are traps only.
        for (const key of ["clean", "smudge", "process"])
          f.git("config", `filter.${token}.${key}`, `touch '${marker}'`);
        f.git("config", `filter.${token}.required`, "true");
        f.write(".gitattributes", `part.ts ${attribute}=${token}\n`);
        if (changed) f.write("part.ts", "const amount = 2;\nunchanged\n");
        try {
          for (const query of [
            { mode: "changes" },
            { mode: "compare", base: "HEAD", target: "WORKING_TREE" },
          ]) {
            const list = await allChanges(f.service, query);
            const file = list.files.find((x) => x.file === "part.ts");
            assert.ok(
              file,
              "an ambiguous conversion must not disappear as clean"
            );
            assert.equal(file.status, "unavailable");
            const view = await f.service.call("get_git_file", {
              listId: list.listId,
              fileId: file.id,
            });
            assert.match(
              view.unavailable,
              /Unknown Git normalization|Unsupported Git working-tree-encoding/
            );
            assert.equal(view.patch, "");
          }
        } finally {
          assert.equal(
            fs.existsSync(marker),
            false,
            "filter trap must not execute"
          );
        }
      });
    }
  }
}

for (const attribute of ["text", "crlf", "eol"]) {
  for (const token of ["set", "unset", "unspecified"]) {
    test(`literal ${attribute}=${token} is not a boolean builtin state`, async (t) => {
      const f = await gitProject(t);
      f.write(".gitattributes", `part.ts ${attribute}=${token}\n`);
      f.write("part.ts", "const amount = 1;\r\nunchanged\r\n");
      for (const autocrlf of [false, true]) {
        f.git("config", "core.autocrlf", String(autocrlf));
        // Built-ins only, owned fixture, no configured filter. This independent
        // native oracle is never used in the service or a filter-trap fixture.
        const patch = f.git(
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          "part.ts"
        );
        assert.equal(patch === "", autocrlf);
        const list = await allChanges(f.service);
        const file = list.files.find((x) => x.file === "part.ts");
        assert.equal(Boolean(file), !autocrlf);
        if (file) assert.equal(file.status, "modified");
      }
    });
  }
}

test("boolean conversion attributes are conservatively unknown, including macro expansion", async (t) => {
  const f = await gitProject(t);
  for (const attribute of ["filter", "working-tree-encoding"]) {
    for (const value of [attribute, `-${attribute}`]) {
      f.write(
        ".gitattributes",
        `[attr]conversion ${value}\npart.ts conversion\n`
      );
      const list = await allChanges(f.service);
      assert.equal(
        list.files.find((x) => x.file === "part.ts")?.status,
        "unavailable"
      );
    }
  }
});

test("ambiguous unindexed text is explicitly unknown; staged blobs and indexed builtin text stay supported", async (t) => {
  const f = await gitProject(t);
  f.write(".gitattributes", "new.ts text\n");
  f.write("new.ts", "const fresh = 1;\n");
  let list = await allChanges(f.service);
  const unknown = list.files.find((x) => x.file === "new.ts");
  assert.equal(unknown.status, "unavailable");
  const view = await f.service.call("get_git_file", {
    listId: list.listId,
    fileId: unknown.id,
  });
  assert.match(
    view.unavailable,
    /ambiguous text attributes on an unindexed path/
  );
  f.git("add", "--", "new.ts"); // owned builtin-only fixture
  list = await allChanges(f.service);
  assert.deepEqual(
    list.files
      .filter((x) => x.file === "new.ts")
      .map((x) => [x.group, x.status]),
    [["staged", "added"]]
  );
  f.write("new.ts", "const fresh = 2;\n");
  list = await allChanges(f.service);
  assert.equal(
    list.files.find((x) => x.file === "new.ts" && x.group === "unstaged")
      ?.status,
    "modified"
  );
});

test("canonical text metadata keeps unmerged files explicitly unavailable rather than rejecting the list", async (t) => {
  const f = await gitProject(t);
  f.write(".gitattributes", "part.ts text\n");
  const base = f.git("rev-parse", "HEAD:part.ts").trim();
  f.gitInput(
    `0 ${"0".repeat(40)}\tpart.ts\n100644 ${base} 1\tpart.ts\n100644 ${base} 2\tpart.ts\n100644 ${base} 3\tpart.ts\n`,
    "update-index",
    "--index-info"
  );
  const list = await allChanges(f.service);
  const files = list.files.filter((x) => x.file === "part.ts");
  assert.deepEqual(
    files.map((x) => x.group),
    ["staged", "unstaged"]
  );
  for (const file of files) {
    const view = await f.service.call("get_git_file", {
      listId: list.listId,
      fileId: file.id,
    });
    assert.match(view.unavailable, /Unmerged/);
  }
});

test("absent/reset conversions and explicit UTF-8 preserve ordinary text/EOL paths", async (t) => {
  const f = await gitProject(t);
  for (const attrs of [
    "",
    "!filter !working-tree-encoding",
    "text eol=lf",
    "-text",
    "working-tree-encoding=UTF-8 text eol=lf",
  ]) {
    f.write(".gitattributes", attrs ? `part.ts ${attrs}\n` : "");
    assert.equal(
      (await allChanges(f.service)).files.some((x) => x.file === "part.ts"),
      false
    );
    f.write("part.ts", "const amount = 2;\nunchanged\n");
    const list = await allChanges(f.service);
    assert.equal(
      list.files.find((x) => x.file === "part.ts")?.status,
      "modified"
    );
    f.write("part.ts", "const amount = 1;\nunchanged\n");
  }
});
