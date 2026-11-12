import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({
  entryPoints: [new URL("../ui/flow-source.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { currentFlowSource } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
function fixture() {
  const attachment = {
    file: "test.ts",
    fileHash: "file",
    startLine: 2,
    startColumn: 2,
    endLine: 4,
    endColumn: 3,
    text: "😀first\n\nend",
  };
  const node = {
    id: "s0",
    stepId: "card",
    label: "Read this block",
    sourceHash: "selected",
    attachment,
  };
  const walk = {
    id: "walk",
    flowState: { status: "current", nodes: [node] },
    steps: [
      {
        id: "card",
        code: {
          file: "test.ts",
          fileHash: "file",
          hash: "selected",
          startLine: 1,
          endLine: 5,
          lines: ["other", "  😀first", "", "end more", "last"],
        },
      },
    ],
  };
  return {
    walk,
    focus: { walkthroughId: walk.id, node: structuredClone(node) },
  };
}
test("Flow focus uses exact current full-file/selected-code/UTF16 multiline identity, never card ID alone", () => {
  const { walk, focus } = fixture();
  assert.equal(currentFlowSource(walk, focus), true);
  for (const mutate of [
    (w) => (w.id = "other"),
    (w) => (w.flowState.status = "stale"),
    (w) => (w.flowState.status = "absent"),
    (w) => (w.flowState.nodes = []),
    (w) => (w.flowState.nodes[0].sourceHash = "new"),
    (w) => (w.flowState.nodes[0].label = "changed"),
    (w) => (w.flowState.nodes[0].attachment.startColumn = 1),
    (w) => (w.steps = []),
    (w) => (w.steps[0].error = "gone"),
    (w) => (w.steps[0].code.file = "other.ts"),
    (w) => (w.steps[0].code.fileHash = "new"),
    (w) => (w.steps[0].code.hash = "new"),
    (w) => (w.steps[0].code.lines[1] = "  changed"),
    (w) => (w.steps[0].code.endLine = 3),
  ]) {
    const changed = structuredClone(walk);
    mutate(changed);
    assert.equal(currentFlowSource(changed, focus), false);
  }
  assert.equal(currentFlowSource(null, focus), false);
  assert.equal(currentFlowSource(walk, null), false);
});
test("Flow targets from one card remain distinct, and ordinary explanation staleness does not relocate a current graph", () => {
  const { walk, focus } = fixture();
  const other = structuredClone(focus.node);
  other.id = "s1";
  other.attachment = {
    ...other.attachment,
    startLine: 4,
    endLine: 4,
    startColumn: 0,
    endColumn: 3,
    text: "end",
  };
  walk.flowState.nodes.push(other);
  walk.steps[0].stale = true;
  assert.equal(currentFlowSource(walk, focus), true);
  assert.equal(
    currentFlowSource(walk, { walkthroughId: walk.id, node: other }),
    true
  );
  const forged = structuredClone(focus);
  forged.node.attachment = other.attachment;
  assert.equal(currentFlowSource(walk, forged), false);
});
