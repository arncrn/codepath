import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({
  entryPoints: [new URL("../ui/flow-changes.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { flowChanges } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
function fixture(before, after, patch) {
  const code = {
    file: "a.ts",
    fileHash: "after-hash",
    hash: "card",
    startLine: 1,
    endLine: after.split("\n").length,
    lines: after.split("\n"),
  };
  const view = {
    before: { content: before },
    after: { content: after, code },
    patch,
    patchMatchesRaw: { before: true, after: true },
  };
  const node = (
    id,
    start,
    end = start,
    endColumn = code.lines[end - 1].length
  ) => ({
    id,
    attachment: {
      file: "a.ts",
      fileHash: "after-hash",
      startLine: start,
      endLine: end,
      startColumn: 0,
      endColumn,
      text: code.lines
        .slice(start - 1, end)
        .map((line, i) => (i === end - start ? line.slice(0, endColumn) : line))
        .join("\n"),
    },
  });
  return { view, node };
}
test("Only linked changed lines get changed colour, not every node in a modified file", () => {
  const f = fixture(
    "one\nold\nthree\n",
    "one\nnew\nthree\n",
    "@@ -1,3 +1,3 @@\n one\n-old\n+new\n three\n"
  );
  assert.deepEqual(
    flowChanges(f.view, [f.node("s0", 1), f.node("s1", 2), f.node("s2", 3)]),
    { s0: "unchanged", s1: "changed", s2: "unchanged" }
  );
});
test("Every real linked line of an added file is changed", () => {
  const f = fixture("", "one\ntwo\n", "@@ -0,0 +1,2 @@\n+one\n+two\n");
  assert.deepEqual(flowChanges(f.view, [f.node("s0", 1), f.node("s1", 2)]), {
    s0: "changed",
    s1: "changed",
  });
});
test("An internal deleted seam changes a multiline region, not its unchanged neighbor", () => {
  const f = fixture(
    "one\ndeleted\ntwo\n",
    "one\ntwo\n",
    "@@ -1,3 +1,2 @@\n one\n-deleted\n two\n"
  );
  assert.deepEqual(flowChanges(f.view, [f.node("s0", 1, 2), f.node("s1", 2)]), {
    s0: "changed",
    s1: "unchanged",
  });
});
test("End-column zero does not include a changed following line", () => {
  const f = fixture(
    "one\ntwo\nold\n",
    "one\ntwo\nnew\n",
    "@@ -1,3 +1,3 @@\n one\n two\n-old\n+new\n"
  );
  assert.equal(flowChanges(f.view, [f.node("s0", 1, 3, 0)]).s0, "unchanged");
});
test("Unverified or normalized patch is unknown rather than falsely unchanged or changed", () => {
  const f = fixture("old\n", "new\n", "@@ -1 +1 @@\n-old\n+new\n");
  f.view.patchMatchesRaw.before = false;
  assert.equal(flowChanges(f.view, [f.node("s0", 1)]).s0, "unknown");
  f.view.patchMatchesRaw.before = true;
  f.view.patch = "@@ bad";
  assert.equal(flowChanges(f.view, [f.node("s0", 1)]).s0, "unknown");
});
test("Literal identical bytes establish unchanged even for mode-only/no aligned patch", () => {
  const f = fixture("same\n", "same\n", "");
  f.view.patchMatchesRaw = { before: false, after: false };
  assert.equal(flowChanges(f.view, [f.node("s0", 1)]).s0, "unchanged");
});
test("A mismatched attachment or unavailable Before source cannot get a trusted change status", () => {
  const f = fixture("old\n", "new\n", "@@ -1 +1 @@\n-old\n+new\n"),
    node = f.node("s0", 1);
  node.attachment.fileHash = "foreign";
  assert.equal(flowChanges(f.view, [node]).s0, "unknown");
  f.view.before.unavailable = "Not inspected";
  f.view.patchMatchesRaw.before = false;
  assert.equal(flowChanges(f.view, [f.node("s0", 1)]).s0, "unknown");
});
test("CRLF and Unicode lines are classified without normalizing source bytes", () => {
  const f = fixture(
    "😀 same\r\nold\r\n",
    "😀 same\r\nnew\r\n",
    "@@ -1,2 +1,2 @@\n 😀 same\r\n-old\r\n+new\r\n"
  );
  assert.deepEqual(flowChanges(f.view, [f.node("s0", 1), f.node("s1", 2)]), {
    s0: "unchanged",
    s1: "changed",
  });
});
