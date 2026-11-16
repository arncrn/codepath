import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({
  entryPoints: [new URL("../ui/after-flow.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { proveAfterFlow } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
function fixture() {
  const paths = ["a.ts", "b.ts"],
    nodes = paths.map((file, i) => ({
      id: "s" + i,
      stepId: file,
      label: file,
      sourceHash: "card-" + file,
      attachment: {
        file,
        fileHash: "whole-" + file,
        startLine: 1,
        endLine: 1,
        startColumn: 6,
        endColumn: 11,
        text: "value",
      },
    })),
    code = (file) => ({
      file,
      fileHash: "whole-" + file,
      hash: "card-" + file,
      startLine: 1,
      endLine: 1,
      lines: ["const value = 1;"],
      excerpt: "const value = 1;",
    }),
    walk = {
      id: "walk",
      flowState: { status: "current", definition: "flowchart TD", nodes },
      steps: paths.map((file) => ({ id: file, code: code(file) })),
    },
    files = paths.map((file) => ({
      id: file,
      file,
      group: "compare",
      status: "modified",
    })),
    views = new Map(
      files.map((file) => [
        file.id,
        {
          file,
          binding: "pair-" + file.id,
          before: {
            code: { ...code(file.file), fileHash: "before-" + file.file },
          },
          after: { code: code(file.file) },
        },
      ])
    );
  return { walk, files, views, code };
}
const query = { mode: "compare", base: "HEAD", target: "WORKING_TREE" };
test("After proof admits the complete authored graph only when every whole-file After version matches", async () => {
  const f = fixture(),
    r = await proveAfterFlow(
      f.walk,
      query,
      f.files,
      async (id) => f.views.get(id),
      () => true
    );
  assert.equal(r.status, "ready");
  assert.deepEqual([...r.files.keys()], ["a.ts", "b.ts"]);
  assert.equal(r.files.get("a.ts").binding, "pair-a.ts");
});
test("One Before-only node rejects the entire graph, not just that node or edge", async () => {
  const f = fixture();
  f.views.get("b.ts").before.code = f.code("b.ts");
  f.views.get("b.ts").after.code.fileHash = "different";
  const r = await proveAfterFlow(
    f.walk,
    query,
    f.files,
    async (id) => f.views.get(id),
    () => true
  );
  assert.equal(r.status, "unavailable");
  assert.match(r.message, /does not match After.*b.ts/);
  assert.equal(r.files, undefined);
});
test("Matching selected text in a different whole file does not establish After identity", async () => {
  const f = fixture();
  f.views.get("a.ts").after.code.fileHash = "changed-elsewhere";
  assert.equal(
    (
      await proveAfterFlow(
        f.walk,
        query,
        f.files,
        async (id) => f.views.get(id),
        () => true
      )
    ).status,
    "unavailable"
  );
});
test("Missing a linked file refuses After before any partial source reads; unchanged/unlisted files are not guessed", async () => {
  const f = fixture();
  let reads = 0;
  const r = await proveAfterFlow(
    f.walk,
    query,
    f.files.slice(0, 1),
    async () => {
      reads++;
    },
    () => true
  );
  assert.equal(r.status, "unavailable");
  assert.equal(reads, 0);
});
test("Changes After means saved working tree, never a matching staged intermediate when unstaged After differs", async () => {
  const f = fixture(),
    files = f.files.flatMap((file) => [
      { ...file, id: file.id + "-staged", group: "staged" },
      { ...file, id: file.id + "-unstaged", group: "unstaged" },
    ]),
    reads = [];
  const r = await proveAfterFlow(
    f.walk,
    { mode: "changes" },
    files,
    async (id) => {
      reads.push(id);
      const path = id.replace(/-(staged|unstaged)$/, "");
      return {
        ...f.views.get(path),
        file: files.find((file) => file.id === id),
        after: {
          code: {
            ...f.code(path),
            fileHash: id.endsWith("-unstaged")
              ? "working-differs"
              : "whole-" + path,
          },
        },
      };
    },
    () => true
  );
  assert.equal(r.status, "unavailable");
  assert.deepEqual(reads, ["a.ts-unstaged"]);
});
test("Unavailable side, renamed After path, or wrong returned file ID cannot authorize a diagram", async () => {
  for (const kind of ["unavailable", "rename", "id"]) {
    const f = fixture(),
      view = f.views.get("a.ts");
    if (kind === "unavailable") view.after.unavailable = "Budget";
    if (kind === "rename") view.after.code.file = "renamed.ts";
    if (kind === "id") view.file = { ...view.file, id: "foreign" };
    assert.equal(
      (
        await proveAfterFlow(
          f.walk,
          query,
          f.files,
          async (id) => f.views.get(id),
          () => true
        )
      ).status,
      "unavailable",
      kind
    );
  }
});
test("Stale/forged card or graph binding never enters After source loading", async () => {
  for (const kind of ["stale", "card"]) {
    const f = fixture();
    if (kind === "stale") f.walk.flowState.status = "stale";
    else f.walk.steps[0].code.hash = "changed";
    let reads = 0;
    const r = await proveAfterFlow(
      f.walk,
      query,
      f.files,
      async () => {
        reads++;
      },
      () => true
    );
    assert.equal(r.status, "unavailable");
    assert.equal(reads, 0);
  }
});
test("Retiring a read cancels the complete proof even when equal source bytes later return", async () => {
  const f = fixture();
  let release, started;
  const gate = new Promise((r) => (release = r)),
    seen = new Promise((r) => (started = r));
  let live = true,
    reads = 0;
  const promise = proveAfterFlow(
    f.walk,
    query,
    f.files,
    async (id) => {
      reads++;
      started();
      await gate;
      return f.views.get(id);
    },
    () => live
  );
  await seen;
  live = false;
  release();
  assert.equal(await promise, null);
  assert.equal(reads, 1);
});
